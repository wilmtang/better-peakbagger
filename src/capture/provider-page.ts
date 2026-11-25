// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Injected on demand into Garmin Connect or Strava's MAIN world. Raw GPX is
// parsed here and never sent to the background worker. Only track-point fields
// used for analysis leave by default; an explicit capture setting may also
// allowlist waypoint coordinates/names and the track name used for Trip Info.

import { isProviderHost, providerFromUrl, providerProfileId } from './provider-url.ts';
import {
    PROVIDER_RESPONSE_PROBE_BYTES,
    PROVIDER_RESPONSE_PROBE_CHARS,
    classifyProviderBody,
    classifyProviderResponse,
} from './provider-response.ts';
import { captureErrorMessage } from './capture-error-policy.ts';
import {
    PROVIDER_EXPORT_TIMEOUT_MS,
    PROVIDER_OWNERSHIP_TIMEOUT_MS,
} from './provider-timing.ts';
import { gpxParse } from '../gpx/gpx-parse.ts';
import { requestDeadline as Deadline } from '../net/request-deadline.ts';
import { boundedText as BoundedText } from '../net/bounded-text.ts';
import {
    MAX_GPX_BYTES,
    MAX_GPX_TEXT_CHARS,
    gpxLimitMessage,
} from './capture-resource-limits.ts';

type ProviderName = 'garmin' | 'strava';
interface ExpectedActivity { provider: ProviderName; activityId: string }
interface OwnershipResult {
    ok: boolean; code?: string; provider?: string; activityId?: string;
    viewerId?: string | null; authorId?: string | null; terminal?: boolean;
}
interface CaptureOptions { includeTripName?: boolean; [option: string]: unknown }
interface RequestDeadline {
    signal?: AbortSignal; readonly expired: boolean;
    run<Value>(promise: Promise<Value>): Promise<Value>; abort(): void; clear(): void;
}
type CodedError = Error & { code?: string; retryAt?: number };
type ProviderGlobals = typeof globalThis & {
    USE_DI_SESSION?: unknown; URL_BUST_VALUE?: unknown; BPBProviderPage?: unknown;
};
const pageGlobals = globalThis as ProviderGlobals;
interface ResponseClass { ok: boolean; code?: string; needsBodyProbe?: boolean; retryAt?: number }
const classifyResponse = classifyProviderResponse as unknown as
    (response: Response, options: { provider?: string; bodyText?: string }) => ResponseClass;
const classifyBody = classifyProviderBody as (text: string) => ResponseClass;

const NO_GPS_MESSAGE = captureErrorMessage('no-gps-data');
const EXPORT_FAILURE_MESSAGE = captureErrorMessage('provider-export-failed');
const EXPORT_TIMEOUT_MESSAGE = captureErrorMessage('provider-export-timeout');
const activeCaptures = new Map<string | symbol, RequestDeadline>();
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
const garminSessionToken = () => document.querySelector('meta[name="csrf-token"]')
    ?.getAttribute('content')?.trim() || '';
const garminSessionReady = () => pageGlobals.USE_DI_SESSION !== true || !!garminSessionToken();

const providerFailure = (code: string, details: object = {}): CodedError => Object.assign(new Error(code), { code, ...details });

const profileId = (href: string | null, provider: ProviderName): string | null => providerProfileId(href, provider, location.href);

const idsInScope = (scope: Element | null, provider: ProviderName): string[] => {
    if (!scope) return [];
    const ids = [...scope.querySelectorAll('a[href]')]
        .map(link => profileId(link.getAttribute('href'), provider))
        .filter((id): id is string => !!id);
    return [...new Set(ids)];
};

const identityFromTiers = (selectorTiers: string[][], provider: ProviderName) => {
    for (const selectors of selectorTiers) {
        const ids = new Set<string>();
        for (const selector of selectors) {
            for (const scope of document.querySelectorAll(selector)) {
                for (const id of idsInScope(scope, provider)) ids.add(id);
            }
        }
        if (ids.size) return ids.size === 1
            ? { id: [...ids][0], ambiguous: false }
            : { id: null, ambiguous: true };
    }
    return { id: null, ambiguous: false };
};

const hasSignedOutCue = (provider: ProviderName) => {
    const links = [...document.querySelectorAll('a[href]')];
    return links.some(link => {
        const href = link.getAttribute('href') || '';
        const text = (link.textContent || '').trim();
        return provider === 'strava'
            ? /\/login(?:[/?#]|$)/i.test(href) || /^log in$/i.test(text)
            : /\/signin(?:[/?#]|$)/i.test(href) || /sign in/i.test(text);
    });
};

const hasHumanCheckCue = () => !!document.querySelector([
    '#challenge-form',
    'input[name="cf-turnstile-response"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '[data-cf-challenge]',
].join(','));

const inspectOwnership = (urlValue: string = location.href): OwnershipResult => {
    const activity = providerFromUrl(urlValue) as ExpectedActivity | null;
    if (!activity) return { ok: false, code: 'unsupported' };
    const { provider, activityId } = activity;

    const viewerSelectorTiers = provider === 'strava'
        ? [['#global-header', '[data-testid="global-header"]'], ['body > header', 'nav[aria-label*="global" i]']]
        : [['#garmin-header', '[data-testid="garmin-header"]', 'header.header'],
            ['body > header', 'nav[aria-label*="global" i]']];
    const authorSelectorTiers = provider === 'strava'
        ? [['[data-testid="activity-header"]', '#heading'], ['main header'], ['main']]
        : [['[data-testid="activity-header"]', '[class*="ActivityHeaderContainer_headerContainer" i]',
            '[class*="ActivityMetaInfo_activityMetadataHeader" i]'], ['main header'], ['main']];
    const viewer = identityFromTiers(viewerSelectorTiers, provider);
    const author = identityFromTiers(authorSelectorTiers, provider);
    const viewerId = viewer.id;
    const authorId = author.id;

    if (hasHumanCheckCue()) {
        return { ok: false, code: 'provider-human-check', provider, activityId, terminal: true };
    }

    const hasEditControl = provider === 'strava'
        ? [...document.querySelectorAll('a[href]')].some(link => {
            try {
                const url = new URL(link.getAttribute('href') || '', location.href);
                return url.protocol === 'https:' && isProviderHost(provider, url.hostname)
                    && url.pathname === `/activities/${activityId}/edit`;
            } catch (_error) {
                return false;
            }
        })
        : [...document.querySelectorAll('a, button')].some(element => {
            const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
            return /edit an activity/i.test(label.trim());
        });

    if (viewer.ambiguous || author.ambiguous) {
        return { ok: false, code: 'ownership-unverified', provider, activityId, terminal: true };
    }
    if (!viewerId) {
        const signedOut = hasSignedOutCue(provider);
        return {
            ok: false,
            code: signedOut ? 'provider-signed-out' : 'ownership-unverified',
            provider,
            activityId,
            ...(signedOut ? { terminal: true } : {}),
        };
    }
    if (authorId && viewerId !== authorId) {
        return { ok: false, code: 'not-owner', provider, activityId, terminal: true };
    }
    if (!authorId || !hasEditControl) {
        return { ok: false, code: 'ownership-unverified', provider, activityId };
    }
    return { ok: true, provider, activityId, viewerId, authorId };
};

const cleanExpectedActivity = (value: unknown): ExpectedActivity | null => {
    const candidate = value as Partial<ExpectedActivity> | null;
    if (!candidate || typeof candidate !== 'object'
        || !['garmin', 'strava'].includes(candidate.provider as string)
        || !/^\d+$/.test(String(candidate.activityId || ''))) return null;
    return { provider: candidate.provider as ProviderName, activityId: String(candidate.activityId) };
};

const inspectExpectedOwnership = (expectedValue: unknown): OwnershipResult => {
    if (expectedValue == null) return inspectOwnership();
    const expected = cleanExpectedActivity(expectedValue);
    if (!expected) return { ok: false, code: 'unsupported' };
    const current = providerFromUrl(location.href) as ExpectedActivity | null;
    if (!current || current.provider !== expected.provider || current.activityId !== expected.activityId) {
        return { ok: false, code: 'activity-changed', ...expected };
    }
    const ownership = inspectOwnership();
    if (ownership.provider !== expected.provider || ownership.activityId !== expected.activityId) {
        return { ok: false, code: 'activity-changed', ...expected };
    }
    return ownership;
};

// Everything that may cross from this page realm to the background worker.
//
// inspectOwnership() also resolves the Garmin/Strava profile identifiers it
// compared. Those are the *evidence* for the decision, not the decision: they
// are third-party account identities, and PRIVACY.md's capture allowlist does
// not list them. They used to ride along on both the ownership reply and the
// successful capture result — never persisted, but the adapters' output is
// documented as narrow, and a field the worker never asked for is exactly how
// that stops being true. They stay here.
const publicOwnership = (result: OwnershipResult | null | undefined): OwnershipResult => {
    if (!result || typeof result !== 'object') return { ok: false, code: 'ownership-unverified' };
    return {
        ok: result.ok === true,
        ...(result.code ? { code: result.code } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.activityId ? { activityId: result.activityId } : {})
    };
};

const waitForOwnership = async (
    expectedActivity: unknown,
    generation: unknown = null,
    timeoutMs: number = PROVIDER_OWNERSHIP_TIMEOUT_MS,
): Promise<OwnershipResult> => {
    const captureKey = typeof generation === 'string' && generation
        ? generation
        : Symbol('ownership');
    const deadline: RequestDeadline = Deadline.createRequestDeadline(timeoutMs);
    activeCaptures.set(captureKey, deadline);
    let observer: MutationObserver | null = null;
    let finish: (result: OwnershipResult) => void = () => {};
    const settled = new Promise<OwnershipResult>(resolve => { finish = resolve; });
    const check = () => {
        if (deadline.signal?.aborted && !deadline.expired) {
            finish({ ok: false, code: 'provider-page-cancelled' });
            return;
        }
        const result = inspectExpectedOwnership(expectedActivity);
        // Garmin can render the author and edit control before its session
        // token. Wait for that same-page state without requesting GPS data.
        if (result.ok && result.provider === 'garmin' && !garminSessionReady()) return;
        if (result.ok || result.terminal === true
            || ['unsupported', 'activity-changed'].includes(result.code as string)) {
            finish(publicOwnership(result));
        }
    };
    try {
        const root = document.documentElement || document.body;
        if (root && typeof MutationObserver === 'function') {
            observer = new MutationObserver(check);
            observer.observe(root, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['href', 'aria-label', 'data-testid', 'name', 'content'],
            });
        }
        deadline.signal?.addEventListener('abort', check, { once: true });
        check();
        return await deadline.run(settled);
    } catch (error) {
        if (deadline.expired || Deadline.isTimeout(error)) {
            const current = providerFromUrl(location.href) as ExpectedActivity | null;
            const ownership = inspectExpectedOwnership(expectedActivity);
            return {
                ok: false,
                code: ownership.ok && ownership.provider === 'garmin' && !garminSessionReady()
                    ? 'provider-session-not-ready' : 'provider-page-not-ready',
                ...(current || cleanExpectedActivity(expectedActivity) || {}),
            };
        }
        return { ok: false, code: 'provider-page-cancelled' };
    } finally {
        observer?.disconnect();
        deadline.signal?.removeEventListener('abort', check);
        deadline.clear();
        if (activeCaptures.get(captureKey) === deadline) activeCaptures.delete(captureKey);
    }
};

const { parseGpxData, cleanName, noGpsError } = gpxParse;

const activityMetadata = (provider: string) => {
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
    let displayedLocalStart: string | null = null;
    if (dateMatch && timeMatch) {
        const month = months.indexOf(dateMatch[1].toLowerCase()) + 1;
        let hour = Number(timeMatch[1]);
        const suffix = (timeMatch[3] || '').toLowerCase();
        if (suffix === 'pm' && hour < 12) hour += 12;
        if (suffix === 'am' && hour === 12) hour = 0;
        const pad = (value: number | string) => String(value).padStart(2, '0');
        displayedLocalStart = `${dateMatch[3]}-${pad(month)}-${pad(dateMatch[2])}T${pad(hour)}:${timeMatch[2]}:00`;
    }
    let utcOffsetMinutes: number | null = null;
    if (provider === 'garmin') {
        const scopes = [
            timeElement?.parentElement,
            ...document.querySelectorAll([
                '[data-testid*="time" i]',
                '[class*="ActivityMetaInfo" i]',
                '[class*="ActivityDetails" i]',
            ].join(',')),
        ].filter((scope): scope is Element => !!scope).slice(0, 8);
        const timeZoneText = scopes
            .map(scope => (scope.textContent || '').slice(0, 500))
            .join(' ');
        const match = /\(UTC([+-])(\d{2}):(\d{2})\)/i.exec(timeZoneText);
        if (match) {
            const value = Number(match[2]) * 60 + Number(match[3]);
            utcOffsetMinutes = match[1] === '-' ? -value : value;
        }
    }
    return { localStart, displayedLocalStart, utcOffsetMinutes } as {
        localStart: string | null; displayedLocalStart: string | null; utcOffsetMinutes: number | null; title?: string;
    };
};

const garminExportRequest = (activityId: string) => {
    const path = `/download-service/export/gpx/activity/${activityId}`;
    const headers: Record<string, string> = {};
    if (typeof pageGlobals.URL_BUST_VALUE === 'string' && pageGlobals.URL_BUST_VALUE) {
        headers['X-app-ver'] = pageGlobals.URL_BUST_VALUE;
    }
    if (pageGlobals.USE_DI_SESSION === true) {
        const csrfToken = garminSessionToken();
        if (!csrfToken) throw providerFailure('provider-session-not-ready');
        headers['Connect-Csrf-Token'] = csrfToken;
        return { endpoint: `/gc-api${path}`, headers };
    }
    return { endpoint: path, headers };
};

// The classifier reads only the leading characters of an unexpected response.
// Read that prefix and stop: a long error or sign-in page is not a large GPX,
// so this read has no failing limit (unlike the GPX read below).
const readResponsePrefix = async (response: Response, signal: AbortSignal | undefined): Promise<string> => {
    const body = response.body as ReadableStream<Uint8Array> | null | undefined;
    if (!body || typeof body.getReader !== 'function') {
        return typeof response.text === 'function' ? String(await response.text()).slice(0, PROVIDER_RESPONSE_PROBE_CHARS) : '';
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0, text = '', ended = false;
    try {
        while (bytes < PROVIDER_RESPONSE_PROBE_BYTES && text.length < PROVIDER_RESPONSE_PROBE_CHARS) {
            if (signal?.aborted) throw Object.assign(new Error('The read was cancelled.'), { name: 'AbortError', code: 'cancelled' });
            const { done, value } = await reader.read();
            if (done) { ended = true; break; }
            bytes += value.byteLength;
            text += decoder.decode(value, { stream: true });
        }
        if (ended) text += decoder.decode();
        return text.slice(0, PROVIDER_RESPONSE_PROBE_CHARS);
    } finally {
        // Release the socket without waiting on a stalled source.
        if (!ended) { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } }
        reader.releaseLock();
    }
};

const capture = async (
    options: CaptureOptions = {},
    generation: unknown = null,
    timeoutMs: number = PROVIDER_EXPORT_TIMEOUT_MS,
    expectedActivity: unknown = null,
    includeDiagnostics = false,
) => {
    const diagnostic = includeDiagnostics === true;
    const durationsMs: Record<string, number> = Object.create(null);
    const counts: Record<string, number> = Object.create(null);
    const measure = diagnostic ? async <Value>(name: string, operation: () => Promise<Value>) => {
        const started = monotonicNow();
        try { return await operation(); }
        finally { durationsMs[name] = Math.round((monotonicNow() - started) * 10) / 10; }
    } : <Value>(_name: string, operation: () => Promise<Value>) => operation();
    const measureSync = diagnostic ? <Value>(name: string, operation: () => Value) => {
        const started = monotonicNow();
        try { return operation(); }
        finally { durationsMs[name] = Math.round((monotonicNow() - started) * 10) / 10; }
    } : <Value>(_name: string, operation: () => Value) => operation();
    const withDiagnostics = <Result extends object>(result: Result) => diagnostic ? {
        ...result,
        diagnostics: { durationsMs: { ...durationsMs }, counts: { ...counts } },
    } : result;
    const ownership = inspectExpectedOwnership(expectedActivity);
    if (!ownership.ok) return withDiagnostics(publicOwnership(ownership));
    const captureKey = typeof generation === 'string' && generation ? generation : Symbol('capture');
    const deadline: RequestDeadline = Deadline.createRequestDeadline(timeoutMs);
    activeCaptures.set(captureKey, deadline);
    let downloading = false;
    try {
        const request = ownership.provider === 'garmin'
            ? garminExportRequest(ownership.activityId as string)
            : { endpoint: `/activities/${ownership.activityId}/export_gpx`, headers: {} };
        downloading = true;
        const response: Response = await measure('headers', () => deadline.run(fetch(request.endpoint, {
            credentials: 'include',
            redirect: 'follow',
            headers: request.headers,
            signal: deadline.signal
        })));
        let responseClass = classifyResponse(response, { provider: ownership.provider });
        if (responseClass.needsBodyProbe) {
            const bodyText = await measure('body', () => deadline.run(readResponsePrefix(response, deadline.signal)));
            responseClass = classifyResponse(response, {
                provider: ownership.provider,
                bodyText,
            });
            // An empty refusal or HTML page carries nothing more to probe.
            if (responseClass.needsBodyProbe) {
                responseClass = { ok: false, code: response.status === 403 ? 'provider-forbidden' : 'provider-response-changed' };
            }
        }
        if (!responseClass.ok) {
            throw responseClass.code === 'no-gps-data'
                ? noGpsError()
                : providerFailure(responseClass.code as string, responseClass);
        }
        const beforeBody = inspectExpectedOwnership(expectedActivity);
        if (!beforeBody.ok) return withDiagnostics(publicOwnership(beforeBody));
        const text: string = await measure('body', () => deadline.run(BoundedText.readBoundedResponseText(response, {
            maxBytes: MAX_GPX_BYTES,
            maxChars: MAX_GPX_TEXT_CHARS,
            signal: deadline.signal,
            label: 'Provider GPX',
        })));
        downloading = false;
        const bodyClass = classifyBody(text);
        if (!bodyClass.ok) {
            throw bodyClass.code === 'no-gps-data'
                ? noGpsError()
                : providerFailure(bodyClass.code as string);
        }
        const afterBody = inspectExpectedOwnership(expectedActivity);
        if (!afterBody.ok) return withDiagnostics(publicOwnership(afterBody));
        const parsed = measureSync('parse', () => parseGpxData(text, options as Parameters<typeof parseGpxData>[1]));
        if (diagnostic) {
            counts['track-points'] = parsed.segments.reduce((sum: number, segment: unknown[]) => sum + segment.length, 0);
            counts.segments = parsed.segments.length;
            counts.waypoints = parsed.waypoints.length;
        }
        const metadata = measureSync('metadata', () => activityMetadata(ownership.provider as string));
        if (options.includeTripName) {
            metadata.title = parsed.trackName
                    || cleanName((document.querySelector('main') || document.body).querySelector('h1')?.textContent || '');
        }
        return withDiagnostics({
            ...publicOwnership(ownership),
            segments: parsed.segments,
            waypoints: parsed.waypoints,
            metadata
        });
    } catch (caught) {
        const error = caught as CodedError | null | undefined;
        const noGps = error?.code === 'no-gps-data';
        const tooLarge = error?.code === 'gpx-too-large' || BoundedText.isLimitError(error);
        const timedOut = deadline.expired || Deadline.isTimeout(error);
        const cancelled = !timedOut && !!deadline.signal?.aborted;
        const classifiedCode = typeof error?.code === 'string' && error.code.startsWith('provider-')
            ? error.code
            : error?.code === 'invalid-gpx' ? 'invalid-gpx' : null;
        const code = noGps ? 'no-gps-data'
            : tooLarge ? 'gpx-too-large'
                : timedOut ? 'provider-export-timeout'
                    : cancelled ? 'provider-export-cancelled'
                        : classifiedCode || (downloading ? 'provider-download-failed' : 'provider-export-failed');
        return withDiagnostics({
            ok: false,
            code,
            provider: ownership.provider,
            activityId: ownership.activityId,
            ...(code === 'provider-rate-limited' && Number.isFinite(error?.retryAt)
                ? { retryAt: error!.retryAt }
                : {}),
            message: noGps ? NO_GPS_MESSAGE
                : tooLarge ? gpxLimitMessage()
                    : timedOut ? EXPORT_TIMEOUT_MESSAGE
                        : code === 'provider-export-failed'
                            ? EXPORT_FAILURE_MESSAGE
                            : captureErrorMessage(code)
        });
    } finally {
        deadline.clear();
        if (activeCaptures.get(captureKey) === deadline) activeCaptures.delete(captureKey);
    }
};

const cancelCapture = (generation: string | symbol) => {
    const deadline = activeCaptures.get(generation);
    if (!deadline) return false;
    deadline.abort();
    return true;
};

const API = {
    providerFromUrl,
    profileId,
    inspectOwnership,
    inspectExpectedOwnership,
    waitForOwnership,
    publicOwnership,
    parseGpxData,
    garminExportRequest,
    capture,
    cancelCapture
};

// Deliberate page-world global (NOT a transitional bridge): background.js
// injects this file with scripting.executeScript, then injects inline funcs
// that call globalThis.BPBProviderPage across the worker→page boundary,
// where ES imports cannot reach. Kept permanently.
pageGlobals.BPBProviderPage = API;
