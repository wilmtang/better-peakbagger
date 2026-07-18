// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Injected on demand into Garmin Connect or Strava's MAIN world. Raw GPX is
// parsed here and never sent to the background worker. Only track-point fields
// used for analysis leave by default; an explicit capture setting may also
// allowlist waypoint coordinates/names and the track name used for Trip Info.


    const PROFILE_PATTERNS = {
        garmin: /\/(?:modern\/)?profile\/([^/?#]+)/i,
        strava: /\/athletes\/(\d+)(?:[/?#]|$)/i
    };

    const providerFromUrl = urlValue => {
        const url = new URL(urlValue);
        let match = /^\/app\/activity\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (url.hostname === 'connect.garmin.com' && match) return { provider: 'garmin', activityId: match[1] };
        match = /^\/activities\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
        if (/(^|\.)strava\.com$/i.test(url.hostname) && match) return { provider: 'strava', activityId: match[1] };
        return null;
    };

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

    const directChild = (element, localName) => [...element.children]
        .find(child => child.localName === localName);

    const elementsByLocalName = (root, localName) => {
        if (root.getElementsByTagNameNS) return [...root.getElementsByTagNameNS('*', localName)];
        return [...root.getElementsByTagName(localName)];
    };

    const cleanName = value => typeof value === 'string'
        ? value.replace(/\s+/g, ' ').trim().slice(0, 200)
        : '';

    const noGpsError = () => {
        const error = new Error('This activity has no recorded route to capture. Manually created activities need recorded track data before a GPX can be generated.');
        error.code = 'no-gps-data';
        return error;
    };

    const parseGpxData = (text, options = {}) => {
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        if (elementsByLocalName(xml, 'parsererror').length) throw new Error('The provider returned invalid GPX XML.');
        const trackSegments = elementsByLocalName(xml, 'trkseg');
        const segments = trackSegments.map(segment => elementsByLocalName(segment, 'trkpt').map(trackPoint => {
            const latText = trackPoint.getAttribute('lat');
            const lonText = trackPoint.getAttribute('lon');
            const elevationText = directChild(trackPoint, 'ele')?.textContent?.trim() || '';
            const timeElement = directChild(trackPoint, 'time');
            const timeText = timeElement?.textContent?.trim() || '';
            const parsedTime = timeText ? Date.parse(timeText) : NaN;
            return {
                lat: latText === null || !latText.trim() ? null : Number(latText),
                lon: lonText === null || !lonText.trim() ? null : Number(lonText),
                ele: elevationText === '' ? null : Number(elevationText),
                time: Number.isFinite(parsedTime) ? parsedTime : null,
                invalidTime: !!timeElement && !Number.isFinite(parsedTime)
            };
        }));
        if (!segments.length || !segments.some(segment => segment.length)) throw noGpsError();
        const waypoints = options.retainWaypoints
            ? elementsByLocalName(xml, 'wpt').map(waypoint => {
                const latText = waypoint.getAttribute('lat');
                const lonText = waypoint.getAttribute('lon');
                return {
                    lat: latText === null || !latText.trim() ? null : Number(latText),
                    lon: lonText === null || !lonText.trim() ? null : Number(lonText),
                    name: cleanName(directChild(waypoint, 'name')?.textContent || '')
                };
            })
            : [];
        const firstTrack = elementsByLocalName(xml, 'trk')[0];
        const trackName = options.includeTripName
            ? cleanName((firstTrack && directChild(firstTrack, 'name')?.textContent) || '')
            : '';
        return { segments, waypoints, trackName };
    };

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

    const capture = async (options = {}) => {
        const ownership = inspectOwnership();
        if (!ownership.ok) return ownership;
        try {
            const request = ownership.provider === 'garmin'
                ? garminExportRequest(ownership.activityId)
                : { endpoint: `/activities/${ownership.activityId}/export_gpx`, headers: {} };
            const response = await fetch(request.endpoint, {
                credentials: 'include',
                redirect: 'follow',
                headers: request.headers
            });
            if (response.status === 204 || response.status === 404) throw noGpsError();
            if (!response.ok) {
                const providerName = ownership.provider === 'garmin' ? 'Garmin' : 'Strava';
                throw new Error(`${providerName} GPX export failed with HTTP ${response.status}. Reload the activity and try again.`);
            }
            const text = await response.text();
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
            return {
                ok: false,
                code: error?.code === 'no-gps-data' ? 'no-gps-data' : 'provider-export-failed',
                provider: ownership.provider,
                activityId: ownership.activityId,
                message: typeof error?.message === 'string' && error.message
                    ? error.message
                    : 'The provider GPX export failed.'
            };
        }
    };

    const API = { providerFromUrl, profileId, inspectOwnership, parseGpxData, garminExportRequest, capture };
    export const providerPage = API;

    // Transitional global bridge; removed in Step 8.
    globalThis.BPBProviderPage = API;
