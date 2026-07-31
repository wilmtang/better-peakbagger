// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Injected on demand into Garmin Connect or Strava's MAIN world. Raw GPX is
// parsed here and never sent to the background worker. Only track-point fields
// used for analysis leave by default; an explicit capture setting may also
// allowlist waypoint coordinates/names and the track name used for Trip Info.

import { providerFromUrl } from './provider-url.js';
import { gpxParse } from '../gpx/gpx-parse.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';

const PROFILE_PATTERNS = {
    garmin: /\/(?:modern\/)?profile\/([^/?#]+)/i,
    strava: /\/athletes\/(\d+)(?:[/?#]|$)/i
};
const NO_GPS_MESSAGE = 'This activity has no recorded route to capture.';
const EXPORT_FAILURE_MESSAGE = 'The activity provider could not export this GPX. Reload the activity and try again.';
const EXPORT_TIMEOUT_MESSAGE = 'The activity provider took too long to export this GPX. Try again.';
const PROVIDER_TIMEOUT_MS = 30000;
const activeCaptures = new Map();

const profileId = (href, provider) => {
    if (!href) return null;
    let pathname;
    try {
        pathname = new URL(href, location.href).pathname;
    } catch (_error) {
        return null;
    }
    const match = PROFILE_PATTERNS[provider].exec(pathname);
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
};

const idsInScope = (scope, provider) => {
    if (!scope) return [];
    const ids = [...scope.querySelectorAll('a[href]')]
        .map(link => profileId(link.getAttribute('href'), provider))
        .filter(Boolean);
    return [...new Set(ids)];
};

const firstScopeWithOneId = (selectors, provider) => {
    for (const selector of selectors) {
        for (const scope of document.querySelectorAll(selector)) {
            const ids = idsInScope(scope, provider);
            if (ids.length === 1) return ids[0];
        }
    }
    return null;
};

const hasSignedOutCue = provider => {
    const links = [...document.querySelectorAll('a[href]')];
    return links.some(link => {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').trim();
        return provider === 'strava'
            ? /\/login(?:[/?#]|$)/i.test(href) || /^log in$/i.test(text)
            : /\/signin(?:[/?#]|$)/i.test(href) || /sign in/i.test(text);
    });
};

const inspectOwnership = (urlValue = location.href) => {
    const activity = providerFromUrl(urlValue);
    if (!activity) return { ok: false, code: 'unsupported' };
    const { provider, activityId } = activity;

    const viewerSelectors = provider === 'strava'
        ? ['#global-header', '[data-testid="global-header"]', 'body > header', 'nav[aria-label*="global" i]']
        : ['#garmin-header', '[data-testid="garmin-header"]', 'header.header', 'body > header', 'nav[aria-label*="global" i]'];
    const authorSelectors = provider === 'strava'
        ? ['[data-testid="activity-header"]', '#heading', 'main header', 'main']
        : ['[data-testid="activity-header"]', '[class*="ActivityHeaderContainer_headerContainer" i]',
            '[class*="ActivityMetaInfo_activityMetadataHeader" i]', 'main header', 'main'];
    const viewerId = firstScopeWithOneId(viewerSelectors, provider);
    const authorId = firstScopeWithOneId(authorSelectors, provider);

    const hasEditControl = provider === 'strava'
        ? [...document.querySelectorAll('a[href]')].some(link => {
            try {
                return new URL(link.getAttribute('href'), location.href).pathname === `/activities/${activityId}/edit`;
            } catch (_error) {
                return false;
            }
        })
        : [...document.querySelectorAll('a, button')].some(element => {
            const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
            return /edit an activity/i.test(label.trim());
        });

    if (!viewerId) {
        return { ok: false, code: hasSignedOutCue(provider) ? 'provider-signed-out' : 'ownership-unverified', provider, activityId };
    }
    if (authorId && viewerId !== authorId) {
        return { ok: false, code: 'not-owner', provider, activityId };
    }
    if (!authorId || !hasEditControl) {
        return { ok: false, code: 'ownership-unverified', provider, activityId };
    }
    return { ok: true, provider, activityId, viewerId, authorId };
};

const { parseGpxData, cleanName, noGpsError } = gpxParse;

const activityMetadata = provider => {
    const main = document.querySelector('main') || document.body;
    const timeElement = main.querySelector('time[datetime]');
    const localStart = timeElement?.getAttribute('datetime') || null;
    const displayedText = (timeElement?.textContent
            || (provider === 'strava' ? document.querySelector('#heading')?.textContent : '')
            || '').trim();
    const months = ['january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'];
    const dateMatch = new RegExp(`(${months.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})`, 'i').exec(displayedText);
    const timeMatch = /(\d{1,2}):(\d{2})\s*([ap]m)/i.exec(displayedText)
            || /(?:^|\bat\s+)([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(displayedText);
    let displayedLocalStart = null;
    if (dateMatch && timeMatch) {
        const month = months.indexOf(dateMatch[1].toLowerCase()) + 1;
        let hour = Number(timeMatch[1]);
        const suffix = (timeMatch[3] || '').toLowerCase();
        if (suffix === 'pm' && hour < 12) hour += 12;
        if (suffix === 'am' && hour === 12) hour = 0;
        const pad = value => String(value).padStart(2, '0');
        displayedLocalStart = `${dateMatch[3]}-${pad(month)}-${pad(dateMatch[2])}T${pad(hour)}:${timeMatch[2]}:00`;
    }
    let utcOffsetMinutes = null;
    if (provider === 'garmin') {
        const match = /\(UTC([+-])(\d{2}):(\d{2})\)/i.exec(main.textContent || '');
        if (match) {
            const value = Number(match[2]) * 60 + Number(match[3]);
            utcOffsetMinutes = match[1] === '-' ? -value : value;
        }
    }
    return { localStart, displayedLocalStart, utcOffsetMinutes };
};

const garminExportRequest = activityId => {
    const path = `/download-service/export/gpx/activity/${activityId}`;
    const headers = {};
    if (typeof globalThis.URL_BUST_VALUE === 'string' && globalThis.URL_BUST_VALUE) {
        headers['X-app-ver'] = globalThis.URL_BUST_VALUE;
    }
    if (globalThis.USE_DI_SESSION === true) {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')?.trim();
        if (!csrfToken) throw new Error('Garmin session verification is unavailable. Reload the activity and try again.');
        headers['Connect-Csrf-Token'] = csrfToken;
        return { endpoint: `/gc-api${path}`, headers };
    }
    return { endpoint: path, headers };
};

const capture = async (options = {}, generation = null, timeoutMs = PROVIDER_TIMEOUT_MS) => {
    const ownership = inspectOwnership();
    if (!ownership.ok) return ownership;
    const request = ownership.provider === 'garmin'
        ? garminExportRequest(ownership.activityId)
        : { endpoint: `/activities/${ownership.activityId}/export_gpx`, headers: {} };
    const captureKey = typeof generation === 'string' && generation ? generation : Symbol('capture');
    const deadline = Deadline.createRequestDeadline(timeoutMs);
    activeCaptures.set(captureKey, deadline);
    try {
        const response = await deadline.run(fetch(request.endpoint, {
            credentials: 'include',
            redirect: 'follow',
            headers: request.headers,
            signal: deadline.signal
        }));
        if (response.status === 204 || response.status === 404) throw noGpsError();
        if (!response.ok) {
            const providerName = ownership.provider === 'garmin' ? 'Garmin' : 'Strava';
            throw new Error(`${providerName} GPX export failed with HTTP ${response.status}. Reload the activity and try again.`);
        }
        const text = await deadline.run(response.text());
        if (!text.trim()) throw noGpsError();
        const parsed = parseGpxData(text, options);
        const metadata = activityMetadata(ownership.provider);
        if (options.includeTripName) {
            metadata.title = parsed.trackName
                    || cleanName((document.querySelector('main') || document.body).querySelector('h1')?.textContent || '');
        }
        return {
            ...ownership,
            segments: parsed.segments,
            waypoints: parsed.waypoints,
            metadata
        };
    } catch (error) {
        const noGps = error?.code === 'no-gps-data';
        const timedOut = deadline.expired || Deadline.isTimeout(error);
        const cancelled = !timedOut && !!deadline.signal?.aborted;
        return {
            ok: false,
            code: noGps ? 'no-gps-data'
                : timedOut ? 'provider-export-timeout'
                    : cancelled ? 'provider-export-cancelled'
                        : 'provider-export-failed',
            provider: ownership.provider,
            activityId: ownership.activityId,
            message: noGps ? NO_GPS_MESSAGE
                : timedOut ? EXPORT_TIMEOUT_MESSAGE
                    : EXPORT_FAILURE_MESSAGE
        };
    } finally {
        deadline.clear();
        if (activeCaptures.get(captureKey) === deadline) activeCaptures.delete(captureKey);
    }
};

const cancelCapture = generation => {
    const deadline = activeCaptures.get(generation);
    if (!deadline) return false;
    deadline.abort();
    return true;
};

const API = {
    providerFromUrl,
    profileId,
    inspectOwnership,
    parseGpxData,
    garminExportRequest,
    capture,
    cancelCapture
};
export const providerPage = API;

// Deliberate page-world global (NOT a transitional bridge): background.js
// injects this file with scripting.executeScript, then injects inline funcs
// that call globalThis.BPBProviderPage across the worker→page boundary,
// where ES imports cannot reach. Kept permanently.
globalThis.BPBProviderPage = API;
