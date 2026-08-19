// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Garmin/Strava capture coordinator. Long-lived state contains only the reduced
// privacy upload and derived ascent values, and lives in storage.session.

// The worker ships as one bundle; capture-core and settings (and their own
// transitive deps: gpx-metrics, settings-schema) resolve through these imports.
import { captureCore as Core } from '../capture/capture-core.js';
import { capturePhases as CapturePhases } from '../capture/capture-phases.js';
import { captureResourceLimits as CaptureLimits } from '../capture/capture-resource-limits.js';
import { providerFromUrl, providerActivityUrl } from '../capture/provider-url.js';
import { createFavoritesStore, favoritesStore as FavoritesStore } from './favorites-store.js';
import { createGithubRoutes } from './github-routes.js';
import { createPhotoRoutes } from './photo-routes.js';
import { reportDraftRoutes as ReportDraftRoutes } from './report-draft-routes.js';
import { createSettingsFileRoutes } from './settings-file-routes.js';
import { terrainActivation as TerrainActivation } from './terrain-activation.js';
import { trustedActions as TrustedActions } from './trusted-actions.js';
import { createTerrainPrefetch } from './terrain-prefetch.js';
import { publicErrors as PublicErrors } from './public-errors.js';
import { settings as Settings } from '../settings/settings.js';
import { peakbaggerAccount as PeakbaggerAccount } from '../peakbagger/peakbagger-account.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import {
    PEAKBAGGER_ORIGIN,
    isPeakbaggerSenderUrl,
    isPeakbaggerUrl,
} from '../peakbagger/peakbagger-origin.js';
import { fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.js';
import { classifyResponse as classifyPeakbaggerResponse } from '../peakbagger/peakbagger-response.js';
import { requestDeadline as Deadline } from '../net/request-deadline.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const JOBS_KEY = 'bpbCaptureJobs';
    const DRAFTS_KEY = 'bpbDraftTabs';
    const JOB_TTL_MS = 30 * 60 * 1000;
    const DRAFT_APPLY_LEASE_MS = 30 * 1000;
    // Save-time GitHub backup snapshots, keyed by climber+peak+date+source tab,
    // expiring on the same 30-minute horizon as a prepared draft.
    const SNAPSHOTS_KEY = 'bpbGithubSnapshots';
    const CLEANUP_ALARM = 'bpb-capture-cleanup';
    const PEAKBAGGER_PAGE_VERSION = 2;
    const UNEXPECTED_CAPTURE_ERROR = Object.freeze({
        code: 'capture-failed',
        message: 'Capture stopped unexpectedly. Reload the activity and try again.',
    });
    const UNEXPECTED_PROCESS_ERROR = Object.freeze({
        code: 'process-failed',
        message: 'The GPX could not be processed. Reload the ascent form and try again.',
    });
    const DRAFT_MANAGER_OPEN_ERROR = Object.freeze({
        code: 'draft-manager-open-failed',
        message: 'Report drafts could not be opened. Try again.',
    });
    const BETA_SETTINGS_OPEN_ERROR = Object.freeze({
        code: 'beta-settings-open-failed',
        message: 'Settings could not be opened. Try again.',
    });
    const processes = new Map();
    const captureAdmissions = new Map();
    const captureCancellationEpochs = new Map();
    const localAnalysisOwners = new Map();
    const lifecycleQueues = new Map();
    const lifecycleEpochs = new Map();
    const peakbaggerPageInjections = new Map();
    const ownedPeakbaggerTabs = new Set();
    let mutationQueue = Promise.resolve();

    const now = () => Date.now();
    const isFresh = record => !!record && Number(record.expiresAt) > now();
    const makeId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const publicFailure = (context, error, fallback) => {
        if (!PublicErrors.isPublic(error)) {
            console.error(`Better Peakbagger: ${context} failed`, error);
        }
        return PublicErrors.expose(error, fallback);
    };
    const storage = () => {
        if (!ext.storage.session) throw new Error('This browser does not provide private session storage.');
        return ext.storage.session;
    };

    const readCapturePreferences = async () => {
        let settings;
        try {
            settings = await Settings.requireCurrent();
        } catch (cause) {
            console.error('Better Peakbagger: capture settings read failed', cause);
            throw PublicErrors.exception(
                'settings-unavailable',
                'Capture settings could not be read. Reload and try again. Nothing was captured.',
                { cause }
            );
        }
        return {
            retainWaypoints: settings.retainWaypoints,
            fillAscentDetails: settings.fillAscentDetails,
            fillTripInfo: settings.fillTripInfo,
            fillWildernessNights: settings.fillWildernessNights,
            fillExternalUrl: settings.fillExternalUrl
        };
    };

    const sameCapturePreferences = (left, right) => !!left && !!right
        && left.retainWaypoints === right.retainWaypoints
        && left.fillAscentDetails === right.fillAscentDetails
        && left.fillTripInfo === right.fillTripInfo
        && left.fillWildernessNights === right.fillWildernessNights
        && left.fillExternalUrl === right.fillExternalUrl;
    const sameProviderActivity = (left, right) => !!left && !!right
        && left.provider === right.provider
        && String(left.activityId) === String(right.activityId);
    const hasProviderActivity = value => !!value
        && typeof value.provider === 'string'
        && value.activityId != null;

    const readMap = async key => (await storage().get(key))[key] || {};
    const mutateMap = (key, mutate) => {
        const operation = mutationQueue.then(async () => {
            const map = await readMap(key);
            const result = await mutate(map);
            await storage().set({ [key]: map });
            return result;
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };
    const mutateLifecycleMaps = mutate => {
        const operation = mutationQueue.then(async () => {
            const [jobs, drafts] = await Promise.all([readMap(JOBS_KEY), readMap(DRAFTS_KEY)]);
            const result = await mutate(jobs, drafts);
            await storage().set({ [JOBS_KEY]: jobs, [DRAFTS_KEY]: drafts });
            return result;
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };

    const runDetachedCleanup = (label, cleanup) => {
        void Promise.resolve().then(cleanup).catch(error => {
            console.error(`Better Peakbagger: ${label} failed`, error);
        });
    };

    // The popup's view of a job: enough to render progress and the match list,
    // and nothing a draft is filled from. boundFallback is narrowed on the same
    // terms as matches — it is an ordinary match with an extra distance, and
    // leaving its draftFields attached would have quietly reopened the hole
    // this function exists to close.
    const publicMatchSummary = match => ({ ...match, draftFields: undefined });
    const publicJob = job => isFresh(job) ? {
        ...job,
        hasCachedGpx: typeof job.uploadGpx === 'string' && job.uploadGpx.length > 0,
        uploadGpx: undefined,
        capturePreferences: undefined,
        tripName: undefined,
        nightsOut: undefined,
        dayStats: undefined,
        matches: (job.matches || []).map(publicMatchSummary),
        boundFallback: job.boundFallback ? publicMatchSummary(job.boundFallback) : job.boundFallback
    } : null;

    const setBadge = async (tabId, text = '', color = '#b42318') => {
        await ext.action.setBadgeBackgroundColor({ tabId, color });
        await ext.action.setBadgeText({ tabId, text });
    };

    const updateCaptureJob = (tabId, generation, patch) => mutateMap(JOBS_KEY, jobs => {
        if (!jobs[tabId] || jobs[tabId].id !== generation) return null;
        jobs[tabId] = { ...jobs[tabId], ...patch, updatedAt: now() };
        return jobs[tabId];
    });

    const failCaptureJob = async (tabId, generation, code, message) => {
        const failed = await updateCaptureJob(tabId, generation, {
            phase: 'error',
            error: { code, message },
        });
        if (!failed) return null;
        if (code === 'not-owner') await setBadge(tabId, '!', '#b42318');
        else if (code === 'ownership-unverified' || code === 'provider-signed-out') await setBadge(tabId, '!', '#b54708');
        return failed;
    };

    const finishCaptureWithoutGps = async (tabId, generation, message) => {
        const finished = await updateCaptureJob(tabId, generation, {
            phase: 'no-gps',
            matches: [],
            selectedIds: [],
            trackSummary: null,
            uploadGpx: null,
            error: null,
            message: message || 'This activity has no recorded route to capture.',
            expiresAt: now() + JOB_TTL_MS
        });
        if (!finished) return null;
        await setBadge(tabId, '');
        return finished;
    };

    const peakbaggerLogin = async ({ request = fetchPeakbaggerResource, signal } = {}) => {
        const response = await request(`${PEAKBAGGER_ORIGIN}/Default.aspx`, { kind: 'html', signal });
        if (response.kind !== 'ok') {
            const failure = PeakbaggerError.exception(response.error);
            // PeakbaggerError owns stable recovery copy, but only PublicError
            // messages may cross the worker boundary. Promote the typed
            // Peakbagger failure here so a human check, outage, or rate limit
            // is not collapsed into the generic unexpected-capture fallback.
            throw PublicErrors.exception(
                failure.code || 'peakbagger-unavailable',
                failure.message,
                { cause: failure },
            );
        }
        const html = response.text;
        const match = /href=["'][^"']*\bcid=(\d+)[^"']*["'][^>]*>[\s\S]{0,80}?My Home Page/i.exec(html)
            || /href=["'][^"']*\/climber\/(?:climberedit|ascentedit)\.aspx\?[^"']*\bcid=(\d+)[^"']*["'][^>]*>[\s\S]{0,80}?(?:Edit Account|Add Ascent)/i.exec(html);
        return match ? match[1] : null;
    };

    const cancelledCaptureError = () => PublicErrors.exception(
        'capture-cancelled',
        'Capture was cancelled. Nothing was retained.',
    );

    const peakbaggerPageError = (code, message, cause) =>
        PublicErrors.exception(code, message, { cause });
    const peakbaggerTabChangedError = cause => peakbaggerPageError(
        'peakbagger-tab-changed',
        'The Peakbagger tab closed or changed during capture. Keep a Peakbagger page open until summit detection finishes, then try again.',
        cause,
    );
    const invalidPeakbaggerPageResponse = (resource, cause) => peakbaggerPageError(
        'peakbagger-response-invalid',
        resource === 'html'
            ? 'Peakbagger returned an account page that could not be verified. Reload Peakbagger, confirm you’re signed in, then try again.'
            : 'Peakbagger returned summit data that could not be verified. Reload Peakbagger and try the capture again.',
        cause,
    );

    const canonicalPeakbaggerTab = tab => {
        try { return new URL(tab?.url).origin === PEAKBAGGER_ORIGIN; }
        catch { return false; }
    };

    const waitForPeakbaggerTab = async (tabId, signal) => {
        const deadline = Deadline.createRequestDeadline(20_000);
        try {
            while (true) {
                if (signal?.aborted) throw cancelledCaptureError();
                const tab = await deadline.run(ext.tabs.get(tabId));
                if (!canonicalPeakbaggerTab(tab)) {
                    throw peakbaggerTabChangedError(new Error('The Peakbagger request tab navigated away.'));
                }
                if (tab.status === 'complete') return tab;
                if (typeof globalThis.setTimeout !== 'function') {
                    throw peakbaggerPageError(
                        'peakbagger-tab-load-failed',
                        'Peakbagger could not finish loading for account verification. Reload Peakbagger, wait for the page to finish, then try again.',
                        new Error('Tab readiness polling is unavailable.'),
                    );
                }
                await deadline.run(new Promise(resolve => globalThis.setTimeout(resolve, 50)));
            }
        } catch (error) {
            if (signal?.aborted) throw cancelledCaptureError();
            if (PublicErrors.isPublic(error)) throw error;
            if (deadline.expired || Deadline.isTimeout(error)) {
                throw peakbaggerPageError(
                    'peakbagger-tab-load-timeout',
                    'Peakbagger did not finish loading within 20 seconds. Reload Peakbagger, wait for the page to finish, then try again.',
                    error,
                );
            }
            throw peakbaggerTabChangedError(error);
        } finally {
            deadline.clear();
        }
    };

    const ensurePeakbaggerPage = tabId => {
        const current = peakbaggerPageInjections.get(tabId);
        if (current) return current;
        const operation = (async () => {
            const probe = async () => {
                const results = await ext.scripting.executeScript({
                    target: { tabId },
                    func: version => globalThis.BPBPeakbaggerPage?.version === version,
                    args: [PEAKBAGGER_PAGE_VERSION],
                    world: 'MAIN',
                });
                return results?.[0]?.result === true;
            };
            if (await probe()) return;
            await ext.scripting.executeScript({
                target: { tabId },
                files: ['peakbagger-page.js'],
                world: 'MAIN',
            });
            if (!await probe()) throw new Error('The Peakbagger page helper did not start.');
        })();
        peakbaggerPageInjections.set(tabId, operation);
        return operation.finally(() => {
            if (peakbaggerPageInjections.get(tabId) === operation) peakbaggerPageInjections.delete(tabId);
        });
    };

    const readFreshPeakbaggerAccount = async (tabId, signal) => {
        if (signal?.aborted) throw cancelledCaptureError();
        try {
            const results = await ext.scripting.executeScript({
                target: { tabId },
                func: version => globalThis.BPBPeakbaggerPage?.version === version
                    ? globalThis.BPBPeakbaggerPage.accountEvidence()
                    : null,
                args: [PEAKBAGGER_PAGE_VERSION],
                world: 'MAIN',
            });
            if (signal?.aborted) throw cancelledCaptureError();
            const tab = await ext.tabs.get(tabId);
            if (!canonicalPeakbaggerTab(tab) || tab.status !== 'complete') return null;
            return PeakbaggerAccount.freshAccountCid(results?.[0]?.result, tab.url);
        } catch (error) {
            if (signal?.aborted || PublicErrors.isPublic(error)) throw error;
            // Evidence is only a fresh-page optimization. Any ambiguity or
            // page-realm failure falls back to the authoritative live request.
            return null;
        }
    };

    const closeOwnedPeakbaggerTab = async tabId => {
        let tab;
        try {
            tab = await ext.tabs.get(tabId);
        } catch {
            ownedPeakbaggerTabs.delete(tabId);
            return;
        }
        try {
            // If the user selected the helper or navigated it elsewhere,
            // ownership has effectively transferred and cleanup leaves it.
            if (!tab.active && canonicalPeakbaggerTab(tab)) await ext.tabs.remove(tabId);
        } finally {
            ownedPeakbaggerTabs.delete(tabId);
        }
    };

    const PAGE_FAILURE_KINDS = Object.freeze({
        cloudflare: 'challenged',
        'signed-out': 'wrong-content',
        network: 'transient',
        timeout: 'transient',
        cancelled: 'transient',
        'response-read': 'transient',
        'response-too-large': 'wrong-content',
        'rate-limit': 'transient',
        server: 'transient',
        'not-found': 'wrong-content',
        http: 'wrong-content',
        'unexpected-content': 'wrong-content',
    });

    const validatePeakbaggerPageResult = (result, requestedUrl, resource) => {
        if (!result || typeof result !== 'object'
            || result.requestedUrl !== requestedUrl
            || !isPeakbaggerUrl(result.url)
            || !Number.isInteger(result.status) || result.status < 0 || result.status > 599
            || typeof result.redirected !== 'boolean') {
            throw invalidPeakbaggerPageResponse(
                resource,
                new Error('The Peakbagger page returned invalid request metadata.'),
            );
        }
        if (result.kind === 'ok') {
            const limit = CaptureLimits.peakbaggerResponseLimit(resource);
            if (typeof result.text !== 'string' || result.text.length > limit
                || new TextEncoder().encode(result.text).byteLength > limit
                || classifyPeakbaggerResponse(result.status, null, result.text, { kind: resource }) !== 'ok') {
                throw invalidPeakbaggerPageResponse(
                    resource,
                    new Error('The Peakbagger page returned invalid response content.'),
                );
            }
            return {
                kind: 'ok',
                requestedUrl,
                url: result.url,
                status: result.status,
                redirected: result.redirected,
                text: result.text,
            };
        }
        const code = typeof result.error?.code === 'string' ? result.error.code : '';
        if (!code || PAGE_FAILURE_KINDS[code] !== result.kind || 'text' in result) {
            throw invalidPeakbaggerPageResponse(
                resource,
                new Error('The Peakbagger page returned an invalid failure.'),
            );
        }
        const error = PeakbaggerError.failure(code, { resource, status: result.status });
        return {
            kind: result.kind,
            requestedUrl,
            url: result.url,
            status: result.status,
            redirected: result.redirected,
            error,
            reason: PeakbaggerError.message(error),
        };
    };

    const peakbaggerPageConnectionError = async (tabId, cause) => {
        let tab;
        try { tab = await ext.tabs.get(tabId); }
        catch { return peakbaggerTabChangedError(cause); }
        if (!canonicalPeakbaggerTab(tab)) return peakbaggerTabChangedError(cause);
        return peakbaggerPageError(
            'peakbagger-page-connect-failed',
            'Better Peakbagger could not connect to the open Peakbagger page. Reload that page, wait for it to finish, then try again.',
            cause,
        );
    };

    const requestThroughPeakbaggerPage = async (tabId, url, { kind, signal } = {}) => {
        if (signal?.aborted) throw cancelledCaptureError();
        let requestId = null;
        let rejectCancellation;
        const cancellation = signal ? new Promise((_, reject) => { rejectCancellation = reject; }) : null;
        cancellation?.catch(() => {});
        const cancel = () => {
            if (requestId === null) {
                rejectCancellation?.(cancelledCaptureError());
                return;
            }
            void ext.scripting.executeScript({
                target: { tabId },
                func: id => globalThis.BPBPeakbaggerPage?.cancel?.(id) === true,
                args: [requestId],
                world: 'MAIN',
            }).catch(() => {});
            rejectCancellation?.(cancelledCaptureError());
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
        const attempt = async () => {
            if (signal?.aborted) throw cancelledCaptureError();
            requestId = makeId();
            const operation = ext.scripting.executeScript({
                target: { tabId },
                func: async (version, id, requestedUrl, resource) => {
                    const api = globalThis.BPBPeakbaggerPage;
                    if (api?.version !== version || typeof api.request !== 'function') {
                        return { bridge: 'missing' };
                    }
                    return {
                        bridge: 'result',
                        value: await api.request(id, requestedUrl, resource),
                    };
                },
                args: [PEAKBAGGER_PAGE_VERSION, requestId, url, kind],
                world: 'MAIN',
            });
            operation.catch(() => {});
            const results = await (cancellation ? Promise.race([operation, cancellation]) : operation);
            if (!results?.[0]) throw new Error('The Peakbagger page returned no request result.');
            return results[0].result;
        };
        try {
            let bridge = await attempt();
            if (bridge?.bridge === 'missing') {
                if (signal?.aborted) throw cancelledCaptureError();
                await ensurePeakbaggerPage(tabId);
                bridge = await attempt();
            }
            if (bridge?.bridge !== 'result') {
                throw new Error('The Peakbagger page returned an invalid bridge result.');
            }
            return validatePeakbaggerPageResult(bridge.value, url, kind);
        } catch (error) {
            if (signal?.aborted || PublicErrors.isPublic(error)) throw error;
            throw await peakbaggerPageConnectionError(tabId, error);
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
    };

    const acquirePeakbaggerPage = async (sourceWindowId, signal) => {
        if (signal?.aborted) throw cancelledCaptureError();
        let tab;
        let created = false;
        try {
            let candidates;
            try {
                candidates = await ext.tabs.query({
                    windowId: sourceWindowId,
                    url: `${PEAKBAGGER_ORIGIN}/*`,
                });
            } catch (error) {
                throw peakbaggerPageError(
                    'peakbagger-tab-access-failed',
                    'Better Peakbagger could not access a Peakbagger tab for this capture. Open Peakbagger in this browser window, then try again.',
                    error,
                );
            }
            tab = candidates.find(candidate => canonicalPeakbaggerTab(candidate)
                && !ownedPeakbaggerTabs.has(candidate.id));
            if (!tab) {
                try {
                    tab = await ext.tabs.create({
                        active: false,
                        ...(Number.isInteger(sourceWindowId) ? { windowId: sourceWindowId } : {}),
                        url: `${PEAKBAGGER_ORIGIN}/Default.aspx`,
                    });
                } catch (error) {
                    throw peakbaggerPageError(
                        'peakbagger-tab-open-failed',
                        'Better Peakbagger could not open Peakbagger for account verification. Open Peakbagger in this browser window, then try again.',
                        error,
                    );
                }
                created = true;
                ownedPeakbaggerTabs.add(tab.id);
            }
            const accountEvidenceIsFresh = created || tab.status !== 'complete';
            await waitForPeakbaggerTab(tab.id, signal);
            await ensurePeakbaggerPage(tab.id);
            return {
                freshAccount: () => accountEvidenceIsFresh
                    ? readFreshPeakbaggerAccount(tab.id, signal)
                    : Promise.resolve(null),
                request: (url, options) => requestThroughPeakbaggerPage(tab.id, url, options),
                release: () => created ? closeOwnedPeakbaggerTab(tab.id) : Promise.resolve(),
            };
        } catch (error) {
            if (created && Number.isInteger(tab?.id)) {
                try { await closeOwnedPeakbaggerTab(tab.id); }
                catch (cleanupError) {
                    console.error('Better Peakbagger: temporary request tab cleanup failed', cleanupError);
                }
            }
            if (signal?.aborted || PublicErrors.isPublic(error)) throw error;
            if (Number.isInteger(tab?.id)) throw await peakbaggerPageConnectionError(tab.id, error);
            throw peakbaggerPageError(
                'peakbagger-tab-access-failed',
                'Better Peakbagger could not access Peakbagger for this capture. Open Peakbagger in this browser window, then try again.',
                error,
            );
        }
    };

    const fetchBox = async (box, { signal, budget, request = fetchPeakbaggerResource }) => {
        const params = new URLSearchParams({
            miny: String(box.miny),
            maxy: String(box.maxy),
            minx: String(box.minx),
            maxx: String(box.maxx)
        });
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (signal?.aborted) throw cancelledCaptureError();
            if (++budget.requests > CaptureLimits.MAX_CORRIDOR_REQUESTS) {
                throw PublicErrors.exception(
                    'track-too-large',
                    'This GPX needs too many summit requests. Split the activity into shorter tracks and try again.',
                );
            }
            const response = await request(
                `https://www.peakbagger.com/Async/pllbb2.aspx?${params}`,
                { kind: 'peaks', signal }
            );
            if (response.kind === 'ok') return response.text;
            if (response.error?.code === 'cancelled') throw cancelledCaptureError();
            lastError = PeakbaggerError.exception(response.error);
            if (response.kind !== 'transient') break;
        }
        throw PublicErrors.exception(
            lastError?.code || 'peakbagger-unavailable',
            lastError?.message || 'Peakbagger could not return nearby summit data. Try again.',
            { cause: lastError }
        );
    };

    const mapWithConcurrency = async (items, concurrency, worker) => {
        const results = new Array(items.length);
        let nextIndex = 0;
        const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index]);
            }
        });
        await Promise.all(runners);
        return results;
    };

    const fetchPeaks = async (boxes, { signal, request }) => {
        const budget = { requests: 0 };
        const responses = await mapWithConcurrency(
            boxes,
            CaptureLimits.CORRIDOR_CONCURRENCY,
            box => fetchBox(box, { signal, budget, request }),
        );
        const byId = new Map();
        responses.forEach(text => Core.parsePeakbaggerPeaks(text).forEach(peak => byId.set(peak.id, peak)));
        return [...byId.values()];
    };

    const injectProvider = tabId => ext.scripting.executeScript({
        target: { tabId },
        files: ['provider-page.js'],
        world: 'MAIN'
    });

    const inspectProviderOwnership = async (tabId, expectedActivity) => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            // Narrowed in the page realm: the worker needs the verdict, not the
            // provider profile identifiers the adapter compared to reach it.
            func: expected => globalThis.BPBProviderPage.publicOwnership(
                globalThis.BPBProviderPage.inspectExpectedOwnership(expected)),
            args: [expectedActivity],
            world: 'MAIN'
        });
        if (!results || !results[0]) throw new Error('The activity page returned no ownership result.');
        return results[0].result;
    };

    const captureProvider = async (tabId, capturePreferences, generation, expectedActivity) => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            func: async (options, captureGeneration, activity) => {
                try {
                    return await globalThis.BPBProviderPage.capture(
                        options,
                        captureGeneration,
                        undefined,
                        activity,
                    );
                } catch (error) {
                    return {
                        ok: false,
                        code: 'provider-export-failed',
                        message: 'The activity provider could not export this GPX. Reload the activity and try again.'
                    };
                }
            },
            args: [{
                retainWaypoints: capturePreferences.retainWaypoints,
                includeTripName: capturePreferences.fillTripInfo
            }, generation, expectedActivity],
            world: 'MAIN'
        });
        if (!results || !results[0]) throw new Error('The activity page returned no capture result.');
        return results[0].result;
    };

    const cancelProviderCapture = async (tabId, generation) => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            func: captureGeneration =>
                globalThis.BPBProviderPage?.cancelCapture?.(captureGeneration) === true,
            args: [generation],
            world: 'MAIN'
        });
        return !!results?.[0]?.result;
    };

    // Shared post-capture pipeline: sanitize → corridor lookup → detect →
    // reduce → serialize → derive. Used by activity capture and the local-file
    // GPX process flow so drafted values can never diverge between the two.
    // Returns a discriminated result; job bookkeeping stays with the caller.
    // boundPid names the peak the calling page is bound to. When the track
    // encounters it below the visible-match bar, the result carries an
    // explicit closest-approach fallback ("Use ⟨peak⟩ anyway") instead of
    // silently promoting a weak match — detection itself stays fail-closed.
    const analyzeTrack = async ({
        segments,
        waypoints,
        metadata,
        capturePreferences,
        boundPid = null,
        onPhase = async () => {},
        signal = null,
        peakbaggerRequest = fetchPeakbaggerResource,
    }) => {
        const deadline = Deadline.createRequestDeadline(CaptureLimits.CORRIDOR_TOTAL_TIMEOUT_MS);
        const cancel = () => deadline.abort();
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
        const assertActive = () => {
            if (signal?.aborted) throw cancelledCaptureError();
            if (deadline.expired) {
                throw PublicErrors.exception(
                    'capture-timeout',
                    'Summit lookup took too long. Try a shorter or less fragmented GPX.',
                );
            }
        };
        try {
            if (!Array.isArray(segments) || segments.length > CaptureLimits.MAX_GPX_TRACK_SEGMENTS
                || (Array.isArray(waypoints) && waypoints.length > CaptureLimits.MAX_GPX_WAYPOINTS)) {
                throw PublicErrors.exception('gpx-too-large', CaptureLimits.gpxLimitMessage());
            }
            let sourcePointCount = 0;
            for (const segment of segments) {
                if (!Array.isArray(segment)) continue;
                sourcePointCount += segment.length;
                if (sourcePointCount > CaptureLimits.MAX_GPX_TRACK_POINTS) {
                    throw PublicErrors.exception('gpx-too-large', CaptureLimits.gpxLimitMessage());
                }
            }
            assertActive();
            const sanitized = Core.sanitizeTrack(segments);
            const cleanWaypoints = capturePreferences.retainWaypoints
                ? Core.sanitizeWaypoints(waypoints)
                : [];
            const pointCount = sanitized.segments.reduce((sum, segment) => sum + segment.length, 0);
            if (pointCount === 0) {
                return { status: 'no-gps', message: 'The exported activity contains no usable route coordinates.' };
            }
            if (pointCount < 2) {
                throw PublicErrors.exception(
                    'invalid-track',
                    'The exported GPX contains fewer than two usable track points.'
                );
            }
            if (sanitized.segments.length > Core.MAX_TRACK_SEGMENTS) {
                throw PublicErrors.exception(
                    'invalid-track',
                    `The sanitized track has ${sanitized.segments.length} segments; Peakbagger allows 50.`
                );
            }

            const boxes = Core.buildQueryBoxes(sanitized.segments);
            if (!boxes.length) {
                throw PublicErrors.exception(
                    'invalid-track',
                    'No valid path remained for summit lookup.'
                );
            }
            if (boxes.length > CaptureLimits.MAX_CORRIDOR_BOXES) {
                throw PublicErrors.exception(
                    'track-too-large',
                    `This GPX needs ${boxes.length} summit-search areas; the safe limit is ${CaptureLimits.MAX_CORRIDOR_BOXES}. Split the activity into shorter tracks and try again.`,
                );
            }
            await onPhase('finding-peaks');
            assertActive();
            const peaks = await deadline.run(fetchPeaks(boxes, {
                signal: deadline.signal,
                request: peakbaggerRequest,
            }));
            assertActive();
            const allMatches = Core.detectPeaks(sanitized.segments, peaks, sanitized.quality.score);
            const visibleMatches = allMatches.filter(match => match.classification === 'strong' || match.classification === 'probable');
            const boundBelowBar = boundPid === null ? null
                : allMatches.find(match => match.id === Number(boundPid)
                && !visibleMatches.some(visible => visible.id === match.id)) || null;
            if (!visibleMatches.length && !boundBelowBar) {
                return {
                    status: 'no-matches',
                    trackSummary: { originalPointCount: pointCount, removedPrivateData: true }
                };
            }
            const trackPointLimit = Core.MAX_UPLOAD_POINTS - cleanWaypoints.length;
            if (trackPointLimit < 2) {
                throw PublicErrors.exception(
                    'too-many-waypoints',
                    `The GPX has ${cleanWaypoints.length} waypoints, leaving no room for a usable track within Peakbagger’s 3,000-point limit.`
                );
            }
            const anchorMatches = boundBelowBar ? [...visibleMatches, boundBelowBar] : visibleMatches;
            const reduced = Core.reduceTrack(sanitized.segments, anchorMatches, trackPointLimit);
            const uploadGpx = Core.serializeUploadGpx(reduced.segments, cleanWaypoints);
            const matches = visibleMatches.map(match => ({
                ...Core.publicMatch(match),
                draftFields: Core.calculateDraftFields(sanitized.segments, match, metadata)
            }));
            const rawTripName = typeof metadata?.title === 'string' ? metadata.title : '';
            // A below-bar bound peak is still selectable on the ascent form. Keep
            // the source name whenever that fallback can turn the operation into a
            // multi-peak trip; prepareDraftOpening() remains the owner of whether
            // the user's eventual selection actually receives Trip Info.
            const tripName = capturePreferences.fillTripInfo
            && matches.length + (boundBelowBar ? 1 : 0) > 1
                ? rawTripName.replace(/\s+/g, ' ').trim().slice(0, 200)
                : '';
            const nightsOut = Core.calculateNightsOut(sanitized.segments, metadata);
            const dayStats = capturePreferences.fillAscentDetails
                ? Core.calculateDayStats(sanitized.segments, metadata)
                : [];

            const boundFallback = boundBelowBar ? {
                ...Core.publicMatch(boundBelowBar),
                selected: false,
                closestApproachM: Math.round(boundBelowBar.encounter.distanceM),
                draftFields: Core.calculateDraftFields(sanitized.segments, boundBelowBar, metadata)
            } : null;

            assertActive();
            return {
                status: 'ready',
                matches,
                boundFallback,
                trackSummary: {
                    originalPointCount: reduced.originalPointCount,
                    retainedPointCount: reduced.retainedPointCount,
                    retainedWaypointCount: cleanWaypoints.length,
                    maxDeviationM: reduced.maxDeviationM,
                    removedPrivateData: true,
                    breakCounts: sanitized.quality
                },
                tripName,
                nightsOut,
                dayStats,
                uploadGpx
            };
        } catch (error) {
            deadline.abort();
            if (signal?.aborted) throw cancelledCaptureError();
            if (deadline.expired || Deadline.isTimeout(error)) {
                throw PublicErrors.exception(
                    'capture-timeout',
                    'Summit lookup took too long. Try a shorter or less fragmented GPX.',
                    { cause: error },
                );
            }
            throw error;
        } finally {
            deadline.clear();
            signal?.removeEventListener('abort', cancel);
        }
    };

    const processCapture = async (tabId, expectedUrl, capturePreferences, generation, signal) => {
        let peakbaggerPage = null;
        try {
            const expectedActivity = providerFromUrl(expectedUrl);
            if (!expectedActivity) {
                await failCaptureJob(
                    tabId,
                    generation,
                    'activity-changed',
                    'The activity page changed before capture started.',
                );
                return;
            }
            const tab = await ext.tabs.get(tabId);
            const startingActivity = providerFromUrl(tab?.url);
            if (!sameProviderActivity(startingActivity, expectedActivity)) {
                await failCaptureJob(
                    tabId,
                    generation,
                    'activity-changed',
                    'The activity page changed before capture started.',
                );
                return;
            }

            if (!await updateCaptureJob(tabId, generation, { phase: 'checking-ownership' })) return;
            await injectProvider(tabId);
            const ownership = await inspectProviderOwnership(tabId, expectedActivity);
            const ownershipMatches = sameProviderActivity(ownership, expectedActivity);
            const ownershipChanged = ownership?.code === 'activity-changed'
                || (hasProviderActivity(ownership) && !ownershipMatches);
            if (!ownership || !ownership.ok || !ownershipMatches) {
                const messages = {
                    unsupported: 'Open a Garmin Connect or Strava activity first.',
                    'activity-changed': 'The activity page changed before capture could finish.',
                    'provider-signed-out': 'Sign in to the activity provider before capturing.',
                    'not-owner': 'This activity was recorded by another account, so it cannot be captured.',
                    'ownership-unverified': 'Ownership could not be verified from this activity page. Nothing was captured.'
                };
                await failCaptureJob(
                    tabId,
                    generation,
                    ownershipChanged ? 'activity-changed' : (ownership?.code || 'capture-failed'),
                    ownershipChanged
                        ? messages['activity-changed']
                        : (messages[ownership?.code] || 'The activity could not be captured.'),
                );
                return;
            }

            if (!await updateCaptureJob(tabId, generation, { phase: 'checking-peakbagger' })) return;
            peakbaggerPage = await acquirePeakbaggerPage(tab.windowId, signal);
            const cid = await peakbaggerPage.freshAccount()
                || await peakbaggerLogin({ request: peakbaggerPage.request, signal });
            if (!cid) {
                await failCaptureJob(
                    tabId,
                    generation,
                    'peakbagger-signed-out',
                    'Your Peakbagger login could not be verified. Open Peakbagger, confirm you’re signed in, then try again.',
                );
                return;
            }
            if (!await updateCaptureJob(tabId, generation, { phase: 'checking-peakbagger' })) return;

            const currentTab = await ext.tabs.get(tabId);
            const currentActivity = providerFromUrl(currentTab.url);
            if (!sameProviderActivity(currentActivity, expectedActivity)) {
                await failCaptureJob(
                    tabId,
                    generation,
                    'activity-changed',
                    'The activity page changed before capture could finish.',
                );
                return;
            }

            const capture = await captureProvider(
                tabId,
                capturePreferences,
                generation,
                expectedActivity,
            );
            const captureMatches = sameProviderActivity(capture, expectedActivity);
            const captureChanged = capture?.code === 'activity-changed'
                || (hasProviderActivity(capture) && !captureMatches);
            if (!capture || !capture.ok || !captureMatches) {
                if (capture?.code === 'no-gps-data' && captureMatches) {
                    await finishCaptureWithoutGps(
                        tabId,
                        generation,
                        'This activity has no recorded route to capture.',
                    );
                    return;
                }
                const messages = {
                    'activity-changed': 'The activity page changed before capture could finish.',
                    'provider-signed-out': 'Sign in to the activity provider before capturing.',
                    'not-owner': 'This activity was recorded by another account, so it cannot be captured.',
                    'ownership-unverified': 'Ownership could not be verified from this activity page. Nothing was captured.',
                    'gpx-too-large': CaptureLimits.gpxLimitMessage(),
                    'provider-export-timeout': 'The activity provider took too long to export this GPX. Try again.',
                    'provider-export-failed': 'The activity provider could not export this GPX. Reload the activity and try again.',
                    // cancelCapture deletes the job before it aborts the page
                    // fetch, so this normally lands on an already-removed job
                    // and is never shown. It is mapped anyway: an unmapped code
                    // would surface a cancellation the user asked for as an
                    // unexplained failure.
                    'provider-export-cancelled': 'Capture was cancelled. Nothing was captured.'
                };
                await failCaptureJob(
                    tabId,
                    generation,
                    captureChanged ? 'activity-changed' : (capture?.code || 'capture-failed'),
                    captureChanged
                        ? messages['activity-changed']
                        : (messages[capture?.code] || 'The activity could not be captured.')
                );
                return;
            }

            if (!await updateCaptureJob(tabId, generation, { phase: 'analyzing' })) return;
            await setBadge(tabId, '');
            const analysis = await analyzeTrack({
                segments: capture.segments,
                waypoints: capture.waypoints,
                metadata: capture.metadata,
                capturePreferences,
                signal,
                peakbaggerRequest: peakbaggerPage.request,
                onPhase: phase => updateCaptureJob(tabId, generation, { phase })
            });
            if (analysis.status === 'no-gps') {
                await finishCaptureWithoutGps(tabId, generation, analysis.message);
                return;
            }
            if (analysis.status === 'no-matches') {
                await updateCaptureJob(tabId, generation, {
                    phase: 'no-matches',
                    matches: [],
                    selectedIds: [],
                    trackSummary: analysis.trackSummary,
                    uploadGpx: null,
                    error: null,
                    expiresAt: now() + JOB_TTL_MS
                });
                return;
            }

            await updateCaptureJob(tabId, generation, {
                phase: 'ready',
                cid,
                provider: capture.provider,
                activityId: capture.activityId,
                matches: analysis.matches,
                selectedIds: analysis.matches.filter(match => match.selected).map(match => match.id),
                trackSummary: analysis.trackSummary,
                tripName: analysis.tripName,
                nightsOut: analysis.nightsOut,
                dayStats: analysis.dayStats,
                uploadGpx: analysis.uploadGpx,
                error: null,
                expiresAt: now() + JOB_TTL_MS
            });
        } catch (error) {
            const failure = publicFailure('activity capture', error, UNEXPECTED_CAPTURE_ERROR);
            await failCaptureJob(tabId, generation, failure.code, failure.message);
        } finally {
            if (peakbaggerPage) {
                try { await peakbaggerPage.release(); }
                catch (error) { console.error('Better Peakbagger: temporary request tab cleanup failed', error); }
            }
            if (processes.get(tabId)?.generation === generation) processes.delete(tabId);
        }
    };

    const serializeCaptureAdmission = (tabId, admit) => {
        const previous = captureAdmissions.get(tabId) || Promise.resolve();
        const operation = previous.catch(() => {}).then(admit);
        captureAdmissions.set(tabId, operation);
        return operation.finally(() => {
            if (captureAdmissions.get(tabId) === operation) captureAdmissions.delete(tabId);
        });
    };

    const admitCapture = async (message, tabId, admissionEpoch) => {
        const cancelled = () => captureCancellationEpochs.get(tabId) !== admissionEpoch;
        const cancelledAdmission = () => ({ kind: 'cancelled' });
        const tab = await ext.tabs.get(tabId);
        if (cancelled()) return cancelledAdmission();
        const capturePreferences = await readCapturePreferences();
        if (cancelled()) return cancelledAdmission();
        const activity = providerFromUrl(tab.url);
        if (!activity) {
            await setBadge(tabId, '');
            if (cancelled()) return cancelledAdmission();
            return {
                kind: 'complete',
                value: {
                    phase: 'error',
                    error: { code: 'unsupported', message: 'Open a Garmin Connect or Strava activity first.' },
                },
            };
        }
        const jobs = await readMap(JOBS_KEY);
        if (cancelled()) return cancelledAdmission();
        const current = jobs[tabId];
        const sameActivity = current && current.provider === activity.provider && current.activityId === activity.activityId;
        if (processes.has(tabId)) {
            return { kind: 'wait', process: processes.get(tabId), activity, capturePreferences };
        }
        if (!message.force && sameActivity && sameCapturePreferences(current.capturePreferences, capturePreferences)
            && current.expiresAt > now() && CapturePhases.isTerminal(current.phase)) {
            return { kind: 'complete', value: publicJob(current) };
        }
        await setBadge(tabId, '');
        if (cancelled()) return cancelledAdmission();

        const job = {
            id: makeId(),
            sourceTabId: tabId,
            provider: activity.provider,
            activityId: activity.activityId,
            phase: 'starting',
            matches: [],
            selectedIds: [],
            capturePreferences,
            createdAt: now(),
            updatedAt: now(),
            expiresAt: now() + JOB_TTL_MS,
            error: null
        };
        abortOwnedWork(tabId);
        invalidateLifecycle(tabId);
        await serializeLifecycle(tabId, () => installLifecycleJob(job));
        if (cancelled()) {
            await mutateMap(JOBS_KEY, map => {
                if (map[tabId]?.id === job.id) delete map[tabId];
            });
            return cancelledAdmission();
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const process = processCapture(tabId, tab.url, capturePreferences, job.id, controller?.signal);
        processes.set(tabId, { generation: job.id, promise: process, controller });
        return { kind: 'started', job, process };
    };

    const startCapture = async message => {
        const tabId = Number(message.tabId);
        while (true) {
            const admissionEpoch = captureCancellationEpochs.get(tabId);
            const admission = await serializeCaptureAdmission(
                tabId,
                () => admitCapture(message, tabId, admissionEpoch),
            );
            if (admission.kind === 'cancelled') return null;
            if (admission.kind === 'complete') return admission.value;
            if (admission.kind === 'wait') {
                await admission.process.promise;
                const completed = (await readMap(JOBS_KEY))[tabId];
                const completedSameActivity = completed
                    && completed.provider === admission.activity.provider
                    && completed.activityId === admission.activity.activityId;
                if (completedSameActivity
                    && sameCapturePreferences(completed.capturePreferences, admission.capturePreferences)) {
                    return publicJob(completed);
                }
                continue;
            }

            await admission.process;
            const completed = (await readMap(JOBS_KEY))[tabId];
            return completed?.id === admission.job.id ? publicJob(completed) : null;
        }
    };

    const clearCaptureTransaction = async message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) {
            throw PublicErrors.exception('invalid-tab', 'Activity tab identity is unavailable.');
        }
        if (processes.has(tabId)) {
            throw PublicErrors.exception(
                'capture-busy',
                'Wait for the current capture to finish before discarding it.'
            );
        }
        const tab = await ext.tabs.get(tabId);
        const activity = providerFromUrl(tab.url);
        if (!activity) {
            throw PublicErrors.exception(
                'activity-changed',
                'Open the captured Garmin or Strava activity before discarding it.'
            );
        }

        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!job) return { ok: true, removedGpx: false, removedDraftCount: 0 };
        if (job.provider !== activity.provider || job.activityId !== activity.activityId) {
            throw PublicErrors.exception(
                'activity-changed',
                'The cached capture belongs to a different activity. Reopen the popup and try again.'
            );
        }

        let removedGpx = false;
        await mutateMap(JOBS_KEY, map => {
            const current = map[tabId];
            if (!current || current.id !== job.id) return;
            removedGpx = typeof current.uploadGpx === 'string' && current.uploadGpx.length > 0;
            delete map[tabId];
        });
        const removedDraftTabIds = await mutateMap(DRAFTS_KEY, drafts => {
            const tabIds = Object.values(drafts)
                .filter(draft => draft.jobId === job.id)
                .map(draft => draft.tabId);
            tabIds.forEach(draftTabId => { delete drafts[draftTabId]; });
            return tabIds;
        });
        await Promise.all(removedDraftTabIds.map(async draftTabId => {
            try {
                await ext.tabs.sendMessage?.(draftTabId, { type: 'DRAFT_CLEARED' });
            } catch (_error) {
                // Closed or still-loading draft tabs need no further cleanup.
            }
        }));
        await setBadge(tabId, '');
        return { ok: true, removedGpx, removedDraftCount: removedDraftTabIds.length };
    };

    const clearCapture = message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) return clearCaptureTransaction(message);
        abortOwnedWork(tabId);
        invalidateLifecycle(tabId);
        return serializeLifecycle(tabId, () => clearCaptureTransaction(message));
    };

    const abortOwnedWork = (tabId, generation = null) => {
        const provider = processes.get(tabId);
        if (provider && (generation === null || provider.generation === generation)) provider.controller?.abort();
        const local = localAnalysisOwners.get(tabId);
        if (local && (generation === null || local.generation === generation)) local.controller?.abort();
    };

    const cancelAdmittedCapture = async (tabId, cancelledAdmission) => {
        let cancelled = cancelledAdmission;
        let current = null;
        await mutateMap(JOBS_KEY, jobs => {
            current = jobs[tabId] || null;
            if (!current || CapturePhases.isTerminal(current.phase)) return;
            delete jobs[tabId];
            cancelled = true;
        });
        if (cancelled && current) {
            const process = processes.get(tabId);
            abortOwnedWork(tabId, current.id);
            if (process?.generation === current.id) processes.delete(tabId);
            try {
                await cancelProviderCapture(tabId, current.id);
            } catch (error) {
                console.error('Better Peakbagger: provider capture cancellation failed', error);
            }
        }
        if (cancelled) await setBadge(tabId, '');
        return { ok: cancelled, cancelled, job: cancelled ? null : publicJob(current) };
    };

    const cancelCapture = message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) {
            throw PublicErrors.exception('invalid-tab', 'Activity tab identity is unavailable.');
        }
        const cancelledAdmission = captureAdmissions.has(tabId) && !processes.has(tabId);
        captureCancellationEpochs.set(tabId, (captureCancellationEpochs.get(tabId) || 0) + 1);
        return serializeCaptureAdmission(
            tabId,
            () => cancelAdmittedCapture(tabId, cancelledAdmission),
        );
    };

    // The selection that produced the open draft tabs is the one that matters.
    // Once drafts exist for the job, a selection write can never take effect —
    // openDrafts() reuses those tabs — so refuse it at the route rather than
    // storing a change the popup would then misreport as actionable.
    const SELECTION_LOCKED_PHASES = new Set(['opening', 'opened', 'previewed']);

    const updateSelectionTransaction = async message => {
        const tabId = Number(message.tabId);
        const current = (await readMap(JOBS_KEY))[tabId];
        if (isFresh(current) && SELECTION_LOCKED_PHASES.has(current.phase)) return current;
        return applySelection(message);
    };

    const updateSelection = message => {
        const tabId = Number(message.tabId);
        return serializeLifecycle(tabId, () => updateSelectionTransaction(message));
    };

    // openDrafts() re-opens a job whose draft tabs were all closed, so the
    // mutation itself stays reachable in phase 'opened'; only the route locks.
    const applySelection = async message => {
        const tabId = Number(message.tabId);
        return mutateMap(JOBS_KEY, jobs => {
            const job = jobs[tabId];
            if (!isFresh(job) || (job.phase !== 'ready' && job.phase !== 'opened')) return null;
            const allowed = new Set(job.matches.map(match => String(match.id)));
            job.selectedIds = [...new Set((message.selectedIds || []).map(String))]
                .filter(id => allowed.has(id))
                .map(Number);
            job.updatedAt = now();
            return job;
        });
    };

    const beginDraftOpening = (message, expectedJobId) => {
        const tabId = Number(message.tabId);
        const openingId = makeId();
        return mutateMap(JOBS_KEY, jobs => {
            const job = jobs[tabId];
            if (!isFresh(job) || job.id !== expectedJobId
                || (job.phase !== 'ready' && job.phase !== 'opened' && job.phase !== 'previewed')) return null;
            if (job.phase === 'ready') {
                const allowed = new Set(job.matches.map(match => String(match.id)));
                job.selectedIds = [...new Set((message.selectedIds || []).map(String))]
                    .filter(id => allowed.has(id))
                    .map(Number);
            }
            job.phase = 'opening';
            job.openingId = openingId;
            job.updatedAt = now();
            return { job: structuredClone(job), openingId };
        });
    };

    const prepareDraftOpening = (job, matches, sourceTabId) => {
        const selection = Core.prepareDraftSelection(matches);
        const useTripInfo = job.capturePreferences?.fillTripInfo && selection.matches.length > 1;
        const useWildernessNights = job.capturePreferences?.fillWildernessNights
            && Number.isInteger(job.nightsOut) && job.nightsOut > 0;
        const makeDraft = (match, {
            tabId,
            previewOrder,
            focusOnReady,
            preserveExistingFields = false,
        }) => ({
            tabId,
            jobId: job.id,
            openingId: job.openingId,
            sourceTabId,
            pid: match.id,
            cid: job.cid,
            classification: match.classification,
            confidence: match.confidence,
            suffix: match.draftFields.suffix,
            tripInfo: useTripInfo ? {
                sequence: selection.sequenceById.get(String(match.id)),
                name: job.tripName || selection.fallbackTripName,
                nightsOut: Number.isInteger(job.nightsOut) ? job.nightsOut : null
            } : null,
            wildernessNightsOut: useWildernessNights ? job.nightsOut : null,
            previewOrder,
            previewStarted: false,
            applyLease: null,
            complete: false,
            dayStatsPending: false,
            focusOnReady,
            preserveExistingFields,
            expiresAt: now() + JOB_TTL_MS
        });
        return { ...selection, makeDraft };
    };

    const lifecycleEpoch = tabId => lifecycleEpochs.get(tabId) || 0;
    const invalidateLifecycle = tabId => {
        lifecycleEpochs.set(tabId, lifecycleEpoch(tabId) + 1);
    };
    const serializeLifecycle = (tabId, operation) => {
        const previous = lifecycleQueues.get(tabId) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        lifecycleQueues.set(tabId, current);
        return current.finally(() => {
            if (lifecycleQueues.get(tabId) === current) lifecycleQueues.delete(tabId);
        });
    };
    const installLifecycleJob = job => {
        const operation = mutationQueue.then(async () => {
            const [jobs, drafts] = await Promise.all([readMap(JOBS_KEY), readMap(DRAFTS_KEY)]);
            const removedDraftTabIds = [];
            Object.entries(drafts).forEach(([draftTabId, draft]) => {
                if (Number(draft.sourceTabId) === Number(job.sourceTabId) && draft.jobId !== job.id) {
                    delete drafts[draftTabId];
                    removedDraftTabIds.push(Number(draftTabId));
                }
            });
            jobs[job.sourceTabId] = job;
            const patch = { [JOBS_KEY]: jobs };
            if (removedDraftTabIds.length) patch[DRAFTS_KEY] = drafts;
            await storage().set(patch);
            await Promise.all(removedDraftTabIds.map(async draftTabId => {
                try {
                    await ext.tabs.sendMessage?.(draftTabId, { type: 'DRAFT_CLEARED' });
                } catch (_error) {
                    // Closed or still-loading draft tabs already lost their
                    // page transaction and need no further cleanup.
                }
            }));
        });
        mutationQueue = operation.catch(() => {});
        return operation;
    };

    const sameDraftIdentity = (left, right) => !!left && !!right
        && Number(left.tabId) === Number(right.tabId)
        && left.jobId === right.jobId
        && left.openingId === right.openingId
        && String(left.pid) === String(right.pid)
        && String(left.cid) === String(right.cid);

    const createDraftOpeningTransaction = ({ jobTabId, priorJob, openingId, epoch }) => {
        const createdTabIds = [];
        const draftWrites = new Map();

        const isCurrent = async () => {
            if (lifecycleEpoch(jobTabId) !== epoch) return false;
            const current = (await readMap(JOBS_KEY))[jobTabId];
            return current?.id === priorJob?.id && current.openingId === openingId
                && (current.phase === 'opening' || current.phase === 'opened' || current.phase === 'previewed');
        };
        const assertCurrent = async () => {
            if (await isCurrent()) return;
            throw PublicErrors.exception(
                'draft-open-cancelled',
                'Draft opening was cancelled because the capture changed.',
            );
        };
        const prepareFinish = patch => mutateMap(JOBS_KEY, jobs => {
            const current = jobs[jobTabId];
            if (lifecycleEpoch(jobTabId) !== epoch || current?.id !== priorJob?.id
                || current.openingId !== openingId || current.phase !== 'opening') return null;
            jobs[jobTabId] = {
                ...current,
                ...patch,
                updatedAt: now(),
            };
            return jobs[jobTabId];
        });
        const finalize = () => mutateLifecycleMaps((jobs, drafts) => {
            const current = jobs[jobTabId];
            if (lifecycleEpoch(jobTabId) !== epoch || current?.id !== priorJob?.id
                || current.openingId !== openingId
                || (current.phase !== 'opened' && current.phase !== 'previewed')) return null;
            const next = { ...current, updatedAt: now() };
            delete next.openingId;
            jobs[jobTabId] = next;
            Object.values(drafts).forEach(draft => {
                if (draft.jobId === priorJob.id && draft.openingId === openingId) delete draft.openingId;
            });
            return next;
        });
        const finish = async patch => {
            const prepared = await prepareFinish(patch);
            if (!prepared) return null;
            return finalize();
        };

        const trackTab = tabId => {
            createdTabIds.push(tabId);
        };
        const writeDraft = draft => mutateMap(DRAFTS_KEY, drafts => {
            const key = String(draft.tabId);
            if (!draftWrites.has(key)) {
                draftWrites.set(key, {
                    previous: drafts[key] ? structuredClone(drafts[key]) : null,
                    installed: draft,
                });
            } else {
                draftWrites.get(key).installed = draft;
            }
            drafts[key] = draft;
        });
        const rollback = async cause => {
            const closeResults = await Promise.allSettled(createdTabIds.map(tabId =>
                Promise.resolve().then(() => ext.tabs.remove(tabId))));
            closeResults.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`Better Peakbagger: failed to close rolled-back draft tab ${createdTabIds[index]}`, result.reason);
                }
            });
            try {
                await mutateLifecycleMaps((jobs, drafts) => {
                    draftWrites.forEach(({ previous, installed }, key) => {
                        if (!sameDraftIdentity(drafts[key], installed)) return;
                        if (previous) drafts[key] = previous;
                        else delete drafts[key];
                    });
                    const current = jobs[jobTabId];
                    if (current?.id === priorJob?.id && current.openingId === openingId) {
                        jobs[jobTabId] = structuredClone(priorJob);
                    }
                });
            } catch (rollbackError) {
                console.error('Better Peakbagger: draft-opening state rollback failed', rollbackError);
            }
            console.error('Better Peakbagger: draft opening failed', cause);
        };

        return { trackTab, writeDraft, assertCurrent, prepareFinish, finalize, finish, rollback };
    };

    const draftTabMatches = (tab, draft) => {
        if (!tab || typeof tab.url !== 'string') return false;
        try {
            const url = new URL(tab.url);
            return isPeakbaggerSenderUrl(tab.url)
                && url.protocol === 'https:'
                && /\/climber\/ascentedit\.aspx$/i.test(url.pathname)
                && url.searchParams.get('pid') === String(draft.pid)
                && url.searchParams.get('cid') === String(draft.cid);
        } catch {
            return false;
        }
    };

    const inspectRecordedDrafts = async (jobId, drafts) => {
        const live = [];
        const stale = [];
        for (const draft of Object.values(drafts).filter(candidate => candidate.jobId === jobId)) {
            if (!isFresh(draft)) {
                stale.push(draft);
                continue;
            }
            try {
                const tab = await ext.tabs.get(draft.tabId);
                (draftTabMatches(tab, draft) ? live : stale).push(draft);
            } catch {
                stale.push(draft);
            }
        }
        if (stale.length) {
            await mutateMap(DRAFTS_KEY, current => {
                stale.forEach(draft => {
                    if (sameDraftIdentity(current[draft.tabId], draft)) delete current[draft.tabId];
                });
            });
        }
        return { live, stale };
    };

    const openNewDraftTabs = async ({
        sourceTabId,
        matches,
        makeDraft,
        transaction,
        startOrder = 0,
        focusFirst = false,
        onBeforeNavigate = null,
    }) => {
        const sourceTab = await ext.tabs.get(sourceTabId);
        await transaction.assertCurrent();
        const created = [];
        for (let index = 0; index < matches.length; index++) {
            const match = matches[index];
            const tab = await ext.tabs.create({ url: 'about:blank', active: false, windowId: sourceTab.windowId });
            transaction.trackTab(tab.id);
            await transaction.assertCurrent();
            const draft = makeDraft(match, {
                tabId: tab.id,
                previewOrder: startOrder + index,
                focusOnReady: focusFirst && index === 0,
            });
            await transaction.writeDraft(draft);
            await transaction.assertCurrent();
            created.push(draft);
        }

        let groupWarning = null;
        if (created.length) {
            try {
                const groupId = await ext.tabs.group({
                    tabIds: created.map(draft => draft.tabId),
                    createProperties: { windowId: sourceTab.windowId }
                });
                await ext.tabGroups.update(groupId, { title: 'Peak Drafts', color: 'green', collapsed: false });
            } catch (error) {
                // Grouping is cosmetic, and the exception text is browser
                // internals. Flag it so each surface can say so in its own
                // plain copy, and keep the cause in the log for diagnosis.
                groupWarning = true;
                console.warn('Better Peakbagger: tab grouping failed', error);
            }
            await transaction.assertCurrent();
        }
        if (onBeforeNavigate) await onBeforeNavigate({ created, groupWarning });
        await transaction.assertCurrent();
        await Promise.all(created.map(draft => ext.tabs.update(draft.tabId, {
            url: `${PEAKBAGGER_ORIGIN}/climber/ascentedit.aspx?pid=${draft.pid}&cid=${draft.cid}`,
            active: false
        })));
        await transaction.assertCurrent();
        return { created, groupWarning };
    };

    const openDraftsTransaction = async (message, tabId) => {
        const jobs = await readMap(JOBS_KEY);
        const existingJob = jobs[tabId];
        if (!isFresh(existingJob)) {
            throw PublicErrors.exception(
                'job-expired',
                'Capture results are no longer available. Capture the activity again.'
            );
        }
        const epoch = lifecycleEpoch(tabId);
        const started = await beginDraftOpening(message, existingJob.id);
        if (!started) {
            throw PublicErrors.exception(
                'job-expired',
                'Capture results are no longer available. Capture the activity again.'
            );
        }
        const job = started.job;
        const transaction = createDraftOpeningTransaction({
            jobTabId: tabId,
            priorJob: existingJob,
            openingId: started.openingId,
            epoch,
        });
        try {
            if (!isFresh(job)) {
                throw PublicErrors.exception(
                    'job-expired',
                    'Capture results are no longer available. Capture the activity again.'
                );
            }
            const existingDrafts = await readMap(DRAFTS_KEY);
            await transaction.assertCurrent();
            const inspected = await inspectRecordedDrafts(job.id, existingDrafts);
            await transaction.assertCurrent();
            const existingForJob = inspected.live
                .sort((a, b) => b.confidence - a.confidence);
            if (existingForJob.length && !inspected.stale.length) {
                for (const draft of existingForJob) {
                    await ext.tabs.update(draft.tabId, { active: false });
                    await transaction.assertCurrent();
                }
                await ext.tabs.update(existingForJob[0].tabId, { active: true });
                await transaction.assertCurrent();
                const opened = await transaction.finish({
                    phase: existingJob.phase === 'previewed' ? 'previewed' : 'opened',
                    openedDraftTabIds: existingForJob.map(draft => draft.tabId),
                    groupWarning: job.groupWarning || null,
                });
                if (!opened) await transaction.assertCurrent();
                return {
                    tabIds: existingForJob.map(draft => draft.tabId),
                    reused: true,
                    job: publicJob(opened)
                };
            }
            if (!job.uploadGpx) {
                throw PublicErrors.exception(
                    'job-expired',
                    'Capture results are no longer available. Capture the activity again.'
                );
            }
            const opening = prepareDraftOpening(
                job,
                job.matches.filter(match => job.selectedIds.includes(match.id)),
                tabId
            );
            if (!opening.matches.length) {
                throw PublicErrors.exception('no-selection', 'Select at least one detected peak.');
            }

            const liveByPeak = new Map(existingForJob.map(draft => [String(draft.pid), draft]));
            const missing = opening.confidenceOrdered.filter(match => !liveByPeak.has(String(match.id)));
            const previewOrder = new Map(opening.confidenceOrdered
                .map((match, index) => [String(match.id), index]));
            const { created, groupWarning } = await openNewDraftTabs({
                sourceTabId: tabId,
                matches: missing,
                makeDraft: (match, options) => opening.makeDraft(match, {
                    ...options,
                    previewOrder: previewOrder.get(String(match.id)),
                }),
                transaction,
                focusFirst: existingForJob.length === 0,
            });
            const allDrafts = [...existingForJob, ...created].sort((a, b) => a.previewOrder - b.previewOrder);
            const tabIds = allDrafts.map(draft => draft.tabId);
            if (existingForJob.length) {
                for (const draft of allDrafts) {
                    await ext.tabs.update(draft.tabId, { active: false });
                    await transaction.assertCurrent();
                }
                await ext.tabs.update(allDrafts[0].tabId, { active: true });
                await transaction.assertCurrent();
            }
            const opened = await transaction.finish({ phase: 'opened', openedDraftTabIds: tabIds, groupWarning });
            if (!opened) await transaction.assertCurrent();
            return { tabIds, groupWarning, reused: false, job: publicJob(opened) };
        } catch (cause) {
            await transaction.rollback(cause);
            if (PublicErrors.isPublic(cause)) throw cause;
            throw PublicErrors.exception(
                'draft-open-failed',
                'Drafts could not be opened. Try again.',
                { cause }
            );
        }
    };

    const openDrafts = message => {
        const tabId = Number(message.tabId);
        return serializeLifecycle(tabId, () => openDraftsTransaction(message, tabId));
    };

    // ---- Local-file GPX processing (ascentedit.aspx upload field) ----------
    //
    // The capture pipeline with a different entry point: the ascent form's own
    // content script parses the chosen file on the page and sends only the
    // allowlisted analysis fields here. Jobs share the capture job map, TTL,
    // cleanup alarm, and the DRAFT_READY/DRAFT_PROCEED handshake; the current
    // tab serves as its own draft tab after the same identity checks.

    const uploadPageIdentity = sender => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) return null;
        let url;
        try {
            url = new URL(sender.url);
        } catch {
            return null;
        }
        if (!/\/climber\/ascentedit\.aspx$/i.test(url.pathname)) return null;
        const pid = Number.parseInt(url.searchParams.get('pid'), 10);
        const cid = url.searchParams.get('cid');
        return {
            tabId: sender.tab.id,
            windowId: sender.tab.windowId,
            pid: Number.isInteger(pid) ? pid : null,
            cid: cid || null
        };
    };

    const uploadMatchSummary = match => ({
        id: match.id,
        name: match.name,
        location: match.location,
        confidence: match.confidence,
        classification: match.classification,
        selected: match.selected,
        date: match.draftFields?.date || '',
        time: match.draftFields?.time || '',
        upDistanceM: Number.isFinite(match.draftFields?.upDistanceM) ? match.draftFields.upDistanceM : null
    });

    const cleanUploadSelection = message => {
        const pageSessionId = typeof message?.pageSessionId === 'string'
            && /^[a-zA-Z0-9:_-]{8,100}$/.test(message.pageSessionId)
            ? message.pageSessionId : null;
        const selectionGeneration = Number(message?.selectionGeneration);
        const selectionNonce = typeof message?.selectionNonce === 'string'
            && /^[a-zA-Z0-9:_-]{8,100}$/.test(message.selectionNonce)
            ? message.selectionNonce : null;
        if (!pageSessionId || !Number.isSafeInteger(selectionGeneration)
            || selectionGeneration <= 0 || !selectionNonce) return null;
        return { pageSessionId, selectionGeneration, selectionNonce };
    };
    const sameUploadSelection = (left, right) => !!left && !!right
        && left.pageSessionId === right.pageSessionId
        && left.selectionGeneration === right.selectionGeneration
        && left.selectionNonce === right.selectionNonce;
    const uploadSelectionIsCurrent = async (tabId, selection) => {
        const jobs = await readMap(JOBS_KEY);
        return jobs[tabId]?.provider === 'upload'
            && sameUploadSelection(jobs[tabId], selection);
    };

    const invalidateGpxSelection = async (message, sender) => {
        const page = uploadPageIdentity(sender);
        const selection = cleanUploadSelection(message);
        if (!page || !selection) return { ok: false, error: { code: 'invalid-selection' } };
        return serializeLifecycle(page.tabId, async () => {
            const jobs = await readMap(JOBS_KEY);
            const current = jobs[page.tabId];
            if (current?.pageSessionId === selection.pageSessionId
                && current.selectionGeneration > selection.selectionGeneration) {
                return { ok: false, error: { code: 'superseded' } };
            }
            abortOwnedWork(page.tabId);
            invalidateLifecycle(page.tabId);
            await mutateMap(JOBS_KEY, currentJobs => {
                currentJobs[page.tabId] = {
                    id: `selection:${selection.pageSessionId}:${selection.selectionGeneration}`,
                    sourceTabId: page.tabId,
                    provider: 'upload',
                    phase: 'selection',
                    createdAt: now(),
                    updatedAt: now(),
                    expiresAt: now() + JOB_TTL_MS,
                    ...selection,
                };
            });
            return { ok: true, ...selection };
        });
    };

    const startGpxProcess = async (message, sender) => {
        const page = uploadPageIdentity(sender);
        const selection = cleanUploadSelection(message);
        const reply = result => ({ ...(result || {}), ...(selection || {}) });
        if (!page) {
            return reply({ phase: 'error', error: { code: 'forbidden', message: 'GPX processing is only available on a Peakbagger ascent form.' } });
        }
        if (!selection || !(await uploadSelectionIsCurrent(page.tabId, selection))) {
            return reply({ phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } });
        }
        const tabId = page.tabId;
        const capturePreferences = await readCapturePreferences();
        if (!(await uploadSelectionIsCurrent(tabId, selection))) {
            return reply({ phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } });
        }
        const cid = await peakbaggerLogin();
        if (!(await uploadSelectionIsCurrent(tabId, selection))) {
            return reply({ phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } });
        }
        if (!cid) {
            return reply({ phase: 'error', error: { code: 'peakbagger-signed-out', message: 'Your Peakbagger login could not be verified. Confirm you’re signed in, then try again.' } });
        }
        if (page.cid && String(page.cid) !== String(cid)) {
            return reply({ phase: 'error', error: { code: 'identity-mismatch', message: 'This ascent form belongs to a different Peakbagger account.' } });
        }

        // Re-picking a file supersedes any earlier job for this tab (same
        // tab-keyed map rule capture uses); late results from a superseded run
        // must never overwrite the newer job.
        const job = {
            id: makeId(),
            sourceTabId: tabId,
            provider: 'upload',
            activityId: null,
            boundPid: page.pid,
            cid,
            phase: 'starting',
            matches: [],
            selectedIds: [],
            capturePreferences,
            createdAt: now(),
            updatedAt: now(),
            expiresAt: now() + JOB_TTL_MS,
            error: null,
            ...selection,
        };
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const installed = await serializeLifecycle(tabId, async () => {
            if (!(await uploadSelectionIsCurrent(tabId, selection))) return false;
            abortOwnedWork(tabId);
            invalidateLifecycle(tabId);
            await installLifecycleJob(job);
            localAnalysisOwners.set(tabId, { generation: job.id, controller });
            return true;
        });
        if (!installed) {
            return reply({ phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } });
        }
        const finish = patch => mutateMap(JOBS_KEY, map => {
            if (!map[tabId] || map[tabId].id !== job.id) return null;
            map[tabId] = { ...map[tabId], ...patch, updatedAt: now(), expiresAt: now() + JOB_TTL_MS };
            return map[tabId];
        });

        try {
            const metadata = {
                utcOffsetMinutes: Core.cleanUtcOffsetMinutes(message.utcOffsetMinutes),
                title: capturePreferences.fillTripInfo && typeof message.trackName === 'string' ? message.trackName : ''
            };
            const analysis = await analyzeTrack({
                segments: Array.isArray(message.segments) ? message.segments : [],
                waypoints: Array.isArray(message.waypoints) ? message.waypoints : [],
                metadata,
                capturePreferences,
                boundPid: page.pid,
                signal: controller?.signal,
            });
            if (analysis.status === 'no-gps') {
                await finish({ phase: 'no-gps', uploadGpx: null, message: analysis.message });
                return reply({ phase: 'no-gps', message: analysis.message });
            }
            if (analysis.status === 'no-matches') {
                await finish({ phase: 'no-matches', trackSummary: analysis.trackSummary, uploadGpx: null });
                return reply({ phase: 'no-matches', boundPid: page.pid });
            }
            const updated = await finish({
                phase: 'ready',
                matches: analysis.matches,
                boundFallback: analysis.boundFallback,
                selectedIds: analysis.matches.filter(match => match.selected).map(match => match.id),
                trackSummary: analysis.trackSummary,
                tripName: analysis.tripName,
                nightsOut: analysis.nightsOut,
                dayStats: analysis.dayStats,
                uploadGpx: analysis.uploadGpx
            });
            if (!updated) {
                return reply({ phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } });
            }
            return reply({
                phase: 'ready',
                jobId: job.id,
                boundPid: page.pid,
                matches: analysis.matches.map(uploadMatchSummary),
                boundFallback: analysis.boundFallback ? {
                    ...uploadMatchSummary(analysis.boundFallback),
                    closestApproachM: analysis.boundFallback.closestApproachM
                } : null
            });
        } catch (error) {
            const failure = publicFailure('local GPX processing', error, UNEXPECTED_PROCESS_ERROR);
            await finish({ phase: 'error', error: failure });
            return reply({ phase: 'error', error: failure });
        } finally {
            if (localAnalysisOwners.get(tabId)?.generation === job.id) localAnalysisOwners.delete(tabId);
        }
    };

    const applyGpxProcessTransaction = async (message, page) => {
        if (!page) {
            return { ok: false, error: { code: 'forbidden', message: 'GPX processing is only available on a Peakbagger ascent form.' } };
        }
        const tabId = page.tabId;
        const jobs = await readMap(JOBS_KEY);
        let job = jobs[tabId];
        const selection = cleanUploadSelection(message);
        if (!selection || !(await uploadSelectionIsCurrent(tabId, selection))
            || !isFresh(job) || job.provider !== 'upload' || job.id !== message.jobId
            || !sameUploadSelection(job, selection)
            || job.phase !== 'ready' || !job.uploadGpx) {
            return { ok: false, error: { code: 'job-expired', message: 'The processed GPX is no longer available. Process the file again.' } };
        }
        // The page's URL cid, when present, must match the job's verified
        // login; a page without one relies on the login check alone.
        if (page.cid !== null && String(page.cid) !== String(job.cid)) {
            return { ok: false, error: { code: 'identity-mismatch', message: 'This ascent form belongs to a different Peakbagger account.' } };
        }
        const byId = new Map(job.matches.map(match => [String(match.id), match]));
        if (job.boundFallback) byId.set(String(job.boundFallback.id), job.boundFallback);
        const selectedIds = [...new Set((message.selectedIds || []).map(String))].filter(id => byId.has(id));
        if (!selectedIds.length) {
            return { ok: false, error: { code: 'no-selection', message: 'Select at least one detected peak.' } };
        }
        // The primary selection fills the current page. A bound page may fill
        // itself only for its own peak; an unbound page becomes the primary's
        // peak by navigation after its draft is registered.
        const primaryId = message.primaryId !== null && message.primaryId !== undefined
            && selectedIds.includes(String(message.primaryId)) ? String(message.primaryId) : null;
        if (primaryId && page.pid !== null && primaryId !== String(page.pid)) {
            return { ok: false, error: { code: 'identity-mismatch', message: 'This form is bound to a different peak.' } };
        }

        const priorJob = job;
        const epoch = lifecycleEpoch(tabId);
        const started = await beginDraftOpening({ ...message, tabId }, job.id);
        if (!started) {
            return { ok: false, error: { code: 'job-expired', message: 'The processed GPX is no longer available. Process the file again.' } };
        }
        job = started.job;

        const opening = prepareDraftOpening(job, selectedIds.map(id => byId.get(id)), tabId);
        const primaryMatch = primaryId
            ? opening.matches.find(match => String(match.id) === primaryId)
            : null;
        const siblings = opening.confidenceOrdered.filter(match => match !== primaryMatch);
        const transaction = createDraftOpeningTransaction({
            jobTabId: tabId,
            priorJob,
            openingId: started.openingId,
            epoch,
        });

        // Every draft is registered before any tab changes URL, so a fast
        // page load can never race its own identity checks.
        try {
            let order = 0;
            if (primaryMatch) {
                const currentDraft = opening.makeDraft(primaryMatch, {
                    tabId,
                    previewOrder: order++,
                    focusOnReady: false,
                    preserveExistingFields: true,
                });
                await transaction.writeDraft(currentDraft);
                await transaction.assertCurrent();
            }
            let tabIds = [];
            const { groupWarning } = await openNewDraftTabs({
                sourceTabId: tabId,
                matches: siblings,
                makeDraft: opening.makeDraft,
                transaction,
                startOrder: order,
                focusFirst: !primaryMatch,
                onBeforeNavigate: async ({ created: pending }) => {
                    tabIds = [...(primaryMatch ? [tabId] : []), ...pending.map(draft => draft.tabId)];
                    await transaction.assertCurrent();
                },
            });
            const prepared = await transaction.prepareFinish({
                phase: 'opened',
                openedDraftTabIds: tabIds,
                groupWarning,
            });
            if (!prepared) await transaction.assertCurrent();
            if (primaryMatch) {
                if (page.pid !== null) {
                    await notifyDraftToProceed({ tabId });
                    await transaction.assertCurrent();
                } else {
                    // Unbound page: peak selection on the native form is a
                    // postback, so the standard draft delivery fills the page
                    // this navigation reloads.
                    await ext.tabs.update(tabId, {
                        url: `${PEAKBAGGER_ORIGIN}/climber/ascentedit.aspx?pid=${primaryMatch.id}&cid=${job.cid}`
                    });
                    await transaction.assertCurrent();
                }
            }
            const opened = await transaction.finalize();
            if (!opened) await transaction.assertCurrent();
            return { ok: true, tabIds, groupWarning };
        } catch (cause) {
            await transaction.rollback(cause);
            return {
                ok: false,
                error: PublicErrors.expose(PublicErrors.exception(
                    'draft-open-failed',
                    'The prepared drafts could not be opened. Try again.',
                    { cause }
                )),
            };
        }
    };

    const applyGpxProcess = (message, sender) => {
        const page = uploadPageIdentity(sender);
        if (!page) {
            return Promise.resolve({
                ok: false,
                error: {
                    code: 'forbidden',
                    message: 'GPX processing is only available on a Peakbagger ascent form.',
                },
            });
        }
        return serializeLifecycle(page.tabId, () => applyGpxProcessTransaction(message, page));
    };

    const validateDraftPage = (draft, message) => String(draft.pid) === String(message.pid)
        && String(draft.cid) === String(message.cid);

    const draftOrder = draft => Number.isInteger(draft.previewOrder) ? draft.previewOrder : Number(draft.tabId);
    const compareDraftOrder = (left, right) => draftOrder(left) - draftOrder(right);
    const orderedDrafts = (drafts, jobId) => Object.values(drafts)
        .filter(candidate => isFresh(candidate) && candidate.jobId === jobId)
        .sort(compareDraftOrder);
    const firstPendingDraft = (drafts, jobId) => orderedDrafts(drafts, jobId)
        .find(candidate => !candidate.complete) || null;

    const notifyDraftToProceed = async draft => {
        if (!draft || !ext.tabs.sendMessage) return;
        try {
            await ext.tabs.sendMessage(draft.tabId, { type: 'DRAFT_PROCEED' });
        } catch (_error) {
            // A tab still loading will run its own ready handshake shortly.
        }
    };

    const normalizedPreviewResult = value => {
        const state = value?.state === 'success' || value?.state === 'error' ? value.state : 'unknown';
        const message = typeof value?.message === 'string'
            ? value.message.replace(/\s+/g, ' ').trim().slice(0, 200)
            : '';
        return { state, message };
    };

    const draftReadyTransaction = async (message, sender) => {
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId)) return { action: 'error', message: 'Draft tab identity is unavailable.' };
        const drafts = await readMap(DRAFTS_KEY);
        const draft = drafts[tabId];
        if (!isFresh(draft)) return { action: 'ignore' };
        if (!validateDraftPage(draft, message)) {
            return { action: 'error', message: 'This Peakbagger page does not match its prepared ascent draft.' };
        }
        const jobs = await readMap(JOBS_KEY);
        // A fresh draft intentionally keeps its source job alive past the
        // job's own TTL; cleanup preserves that relationship until every draft
        // expires or closes.
        const job = Object.values(jobs).find(candidate => candidate.id === draft.jobId);
        if (!job) return { action: 'error', message: 'The private draft data expired. Capture the activity again.' };
        const match = job.matches.find(candidate => candidate.id === draft.pid)
            // An upload job's bound peak may have been drafted through the
            // explicit closest-approach override rather than a visible match.
            || (job.boundFallback && job.boundFallback.id === draft.pid ? job.boundFallback : null);
        if (!match) return { action: 'error', message: 'The selected peak is no longer available.' };
        const peakName = typeof match.name === 'string' ? match.name : '';

        if (draft.complete) {
            return {
                action: 'banner',
                peakName,
                classification: draft.classification,
                confidence: draft.confidence,
                ...(draft.dayStatsPending ? {
                    jobId: job.id,
                    pid: draft.pid,
                    cid: draft.cid,
                    dayStats: job.dayStats || [],
                    dayStatsPending: true
                } : {})
            };
        }

        if (draft.previewStarted) {
            const result = normalizedPreviewResult(message.previewResult);
            if (result.state !== 'success') {
                await mutateMap(DRAFTS_KEY, map => {
                    if (!sameDraftIdentity(map[tabId], draft)) return;
                    map[tabId].previewStarted = false;
                    map[tabId].previewError = result.message || 'Peakbagger returned no success confirmation.';
                });
                const explanation = result.state === 'error' && result.message
                    ? `Peakbagger rejected GPS Preview: ${result.message}`
                    : 'Peakbagger did not confirm that GPS Preview succeeded.';
                return {
                    action: 'preview-error',
                    peakName,
                    message: `${explanation} The GPX and draft were kept.`
                };
            }
            await mutateMap(DRAFTS_KEY, map => {
                if (!sameDraftIdentity(map[tabId], draft)) return;
                map[tabId].complete = true;
                map[tabId].previewError = null;
                map[tabId].dayStatsPending = job.capturePreferences?.fillAscentDetails !== false
                    && Array.isArray(job.dayStats) && job.dayStats.length > 1;
            });
            const currentDrafts = await readMap(DRAFTS_KEY);
            const nextDraft = firstPendingDraft(currentDrafts, draft.jobId);
            if (nextDraft) await notifyDraftToProceed(nextDraft);
            else await updateCaptureJob(draft.sourceTabId, job.id, { phase: 'previewed', uploadGpx: null });
            const completedDraft = currentDrafts[tabId];
            return {
                action: 'banner',
                peakName,
                classification: draft.classification,
                confidence: draft.confidence,
                ...(completedDraft?.dayStatsPending ? {
                    jobId: job.id,
                    pid: draft.pid,
                    cid: draft.cid,
                    dayStats: job.dayStats,
                    dayStatsPending: true
                } : {})
            };
        }

        const currentDraft = firstPendingDraft(drafts, draft.jobId);
        if (!currentDraft || currentDraft.tabId !== tabId) {
            return { action: 'wait', peakName, message: 'Waiting for the previous GPS Preview to finish.' };
        }

        if (draft.focusOnReady) {
            await ext.tabs.update(tabId, { active: true });
            await mutateMap(DRAFTS_KEY, map => {
                if (sameDraftIdentity(map[tabId], draft)) map[tabId].focusOnReady = false;
            });
        }
        const applyLeaseToken = makeId();
        const applyLeaseExpiresAt = now() + DRAFT_APPLY_LEASE_MS;
        const claimed = await mutateMap(DRAFTS_KEY, map => {
            const current = map[tabId];
            const first = current ? firstPendingDraft(map, current.jobId) : null;
            if (!sameDraftIdentity(current, draft) || !isFresh(current)
                || first?.tabId !== tabId || current.previewStarted || current.complete
                || (current.applyLease && current.applyLease.expiresAt > now())) return false;
            current.applyLease = { token: applyLeaseToken, expiresAt: applyLeaseExpiresAt };
            return true;
        });
        if (!claimed) {
            return { action: 'wait', peakName, message: 'This draft is already being prepared.' };
        }
        return {
            action: 'apply',
            peakName,
            jobId: job.id,
            pid: draft.pid,
            cid: draft.cid,
            classification: draft.classification,
            confidence: draft.confidence,
            applyLeaseToken,
            applyLeaseExpiresAt,
            preserveExistingFields: draft.preserveExistingFields === true,
            fields: {
                ...match.draftFields,
                suffix: draft.suffix || '',
                fillAscentDetails: job.capturePreferences?.fillAscentDetails !== false,
                // Rebuilt from provider+activityId (never the raw tab URL);
                // null for local-GPX jobs (no activityId) or when the setting
                // is off, so nothing is written into #URLTB.
                externalUrl: job.capturePreferences?.fillExternalUrl !== false
                    ? providerActivityUrl(job) : null,
                dayStats: job.dayStats || [],
                tripInfo: draft.tripInfo || null,
                wildernessNightsOut: draft.wildernessNightsOut ?? null
            },
            allowWaypoints: !!job.capturePreferences?.retainWaypoints,
            gpx: job.uploadGpx
        };
    };

    const draftReady = async (message, sender) => {
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId)) return { action: 'error', message: 'Draft tab identity is unavailable.' };
        const draft = (await readMap(DRAFTS_KEY))[tabId];
        if (!isFresh(draft)) return { action: 'ignore' };
        return serializeLifecycle(draft.sourceTabId, () => draftReadyTransaction(message, sender));
    };

    const previewStartedTransaction = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            const currentDraft = draft ? firstPendingDraft(drafts, draft.jobId) : null;
            if (!isFresh(draft) || currentDraft?.tabId !== tabId || draft.jobId !== message.jobId
                || !validateDraftPage(draft, message) || draft.previewStarted || draft.complete
                || typeof message.applyLeaseToken !== 'string'
                || draft.applyLease?.token !== message.applyLeaseToken
                || draft.applyLease.expiresAt <= now()) {
                if (draft?.applyLease?.expiresAt <= now()) draft.applyLease = null;
                return { ok: false };
            }
            draft.applyLease = null;
            draft.previewStarted = true;
            draft.expiresAt = now() + JOB_TTL_MS;
            return { ok: true };
        });
    };

    const previewStarted = async (message, sender) => {
        const draft = (await readMap(DRAFTS_KEY))[sender.tab?.id];
        if (!draft) return { ok: false };
        return serializeLifecycle(draft.sourceTabId, () => previewStartedTransaction(message, sender));
    };

    const dayStatsAppliedTransaction = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            if (!isFresh(draft) || !draft.complete || !draft.dayStatsPending || draft.jobId !== message.jobId
                || !validateDraftPage(draft, message)) return { ok: false };
            draft.dayStatsPending = false;
            draft.expiresAt = now() + JOB_TTL_MS;
            return { ok: true };
        });
    };

    const dayStatsApplied = async (message, sender) => {
        const draft = (await readMap(DRAFTS_KEY))[sender.tab?.id];
        if (!draft) return { ok: false };
        return serializeLifecycle(draft.sourceTabId, () => dayStatsAppliedTransaction(message, sender));
    };

    const cleanupSource = async (sourceTabId, cutoff) => {
        const result = await mutateMap(DRAFTS_KEY, map => {
            const removedDraftTabIds = [];
            Object.entries(map).forEach(([tabId, draft]) => {
                if (Number(draft.sourceTabId) === Number(sourceTabId) && draft.expiresAt <= cutoff) {
                    delete map[tabId];
                    removedDraftTabIds.push(Number(tabId));
                }
            });
            return { drafts: { ...map }, removedDraftTabIds };
        });
        const activeJobIds = new Set(Object.values(result.drafts).map(draft => draft.jobId));
        await mutateMap(JOBS_KEY, jobs => {
            const job = jobs[sourceTabId];
            if (job?.expiresAt <= cutoff && !activeJobIds.has(job.id)) delete jobs[sourceTabId];
        });
        await Promise.all(result.removedDraftTabIds.map(async draftTabId => {
            try {
                await ext.tabs.sendMessage?.(draftTabId, { type: 'DRAFT_CLEARED' });
            } catch (_error) {
                // Closed or still-loading tabs require no page rollback.
            }
        }));
    };

    const cleanup = async () => {
        const cutoff = now();
        const [jobs, drafts] = await Promise.all([readMap(JOBS_KEY), readMap(DRAFTS_KEY)]);
        const sourceTabIds = new Set([
            ...Object.keys(jobs).map(Number),
            ...Object.values(drafts).map(draft => Number(draft.sourceTabId)),
        ].filter(Number.isInteger));
        await Promise.all([...sourceTabIds].map(sourceTabId => {
            const expiring = jobs[sourceTabId]?.expiresAt <= cutoff
                || Object.values(drafts).some(draft => Number(draft.sourceTabId) === sourceTabId
                    && draft.expiresAt <= cutoff);
            if (expiring) {
                abortOwnedWork(sourceTabId, jobs[sourceTabId]?.id ?? null);
                invalidateLifecycle(sourceTabId);
            }
            return serializeLifecycle(sourceTabId, () => cleanupSource(sourceTabId, cutoff));
        }));
        await githubRoutes.cleanup(cutoff);
        await trustedActions.cleanup(cutoff);
        await photoRoutes.cleanup(cutoff);
        await reportDraftRoutes.cleanup(cutoff);
    };

    const isPeakbaggerSender = sender =>
        !!(sender && sender.tab && sender.url && isPeakbaggerSenderUrl(sender.url));

    const isClimbListSender = sender => {
        if (!isPeakbaggerSender(sender)) return false;
        try { return /\/climber\/climblistc\.aspx$/i.test(new URL(sender.url).pathname); }
        catch { return false; }
    };

    // Only extension-owned pages may call account setup and navigation routes.
    const isExtensionPage = sender => {
        try { return !!(sender?.url && sender.url.startsWith(ext.runtime.getURL(''))); }
        catch { return false; }
    };

    const terrainFrameUrl = (() => {
        try { return ext.runtime.getURL('terrain/terrain.html'); }
        catch { return null; }
    })();
    const isTerrainFrameSender = sender => !!(terrainFrameUrl && sender?.url === terrainFrameUrl
        && Number.isInteger(sender?.tab?.id));
    const terrainActivation = TerrainActivation.create({
        isPeakbaggerSender,
        isTerrainFrameSender,
        now,
    });
    const trustedActions = TrustedActions.create({
        storage,
        isPeakbaggerSender,
        now,
    });

    const terrainPrefetch = createTerrainPrefetch({
        isPeakbaggerSender,
        consumeActivation: terrainActivation.consumePrefetch,
        mapWithConcurrency,
        now
    });

    const githubRoutes = createGithubRoutes({
        ext,
        snapshotKey: SNAPSHOTS_KEY,
        storage,
        now,
        peakbaggerLogin,
        isPeakbaggerSender,
        isClimbListSender,
        isFresh,
        readMap,
        mutateMap,
    });
    const photoRoutes = createPhotoRoutes({
        ext,
        storage,
        now,
        isPeakbaggerSender,
        mutateMap,
        readMap,
    });
    const reportDraftRoutes = ReportDraftRoutes.createReportDraftRoutes({
        ext,
        now,
        isPeakbaggerSender,
        isExtensionPage,
        mutateMap,
    });
    const settingsFileRoutes = createSettingsFileRoutes({
        ext,
        verifyGithubConnection: githubRoutes.validateImportedConnection,
    });
    const favoriteMutations = createFavoritesStore({ storage: ext.storage.local, now });

    const openDraftsManager = async sender => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: {
                    code: 'forbidden',
                    message: 'Report drafts can only be opened from a Peakbagger page.',
                },
            };
        }
        try {
            const tab = await ext.tabs.create({
                url: ext.runtime.getURL('options/drafts.html')
            });
            return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null };
        } catch (error) {
            return {
                ok: false,
                error: publicFailure('report drafts manager tab opening', error, DRAFT_MANAGER_OPEN_ERROR),
            };
        }
    };

    const openBetaSettings = async sender => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: {
                    code: 'forbidden',
                    message: 'Beta settings can only be opened from a Peakbagger page.',
                },
            };
        }
        try {
            const tab = await ext.tabs.create({
                url: ext.runtime.getURL('options/options.html#beta'),
                active: true,
                ...(Number.isInteger(sender.tab.windowId) ? { windowId: sender.tab.windowId } : {}),
            });
            return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null };
        } catch (error) {
            return {
                ok: false,
                error: publicFailure('beta settings tab opening', error, BETA_SETTINGS_OPEN_ERROR),
            };
        }
    };

    ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const run = async () => {
            const type = message?.type;
            // Account setup and navigation helpers are extension-page only;
            // neither the GitHub token nor the signed-in climber identity
            // crosses to a content script.
            if (githubRoutes.isExtensionOnly(type) && !isExtensionPage(sender)) {
                return { error: 'forbidden' };
            }
            const settingsFileHandler = settingsFileRoutes.handlers[type];
            if (settingsFileHandler) return settingsFileHandler(message, sender);
            const photoHandler = photoRoutes.handlers[type];
            if (photoHandler) return photoHandler(message, sender);
            const reportDraftHandler = reportDraftRoutes.handlers[type];
            if (reportDraftHandler) return reportDraftHandler(message, sender);
            const githubHandler = githubRoutes.handlers[type];
            if (githubHandler) return githubHandler(message, sender);
            switch (type) {
            case 'SETTINGS_PATCH':
                // Settings and favorites share one sender gate: extension pages
                // and the Peakbagger content scripts. Nothing else runs
                // extension code, so the worker's mutation routes fail closed
                // rather than trusting whatever reaches runtime messaging.
                if (!isExtensionPage(sender) && !isPeakbaggerSender(sender)) {
                    return {
                        ok: false,
                        error: {
                            code: 'forbidden',
                            message: 'This page cannot change settings.',
                        },
                    };
                }
                return { ok: true, settings: await Settings.applyPatch(message.patch) };
            case FavoritesStore.MESSAGE_TYPE:
                if (!isExtensionPage(sender) && !isPeakbaggerSender(sender)) {
                    return {
                        ok: false,
                        error: {
                            code: 'forbidden',
                            message: 'This page cannot change favorite climbers.',
                        },
                    };
                }
                return favoriteMutations.mutate(message.mutation);
            case 'OPEN_BETA_SETTINGS': return openBetaSettings(sender);
            case 'OPEN_DRAFTS_MANAGER': return openDraftsManager(sender);
            case 'CAPTURE_START': return startCapture(message);
            case 'CAPTURE_STATUS': {
                const jobs = await readMap(JOBS_KEY);
                const job = jobs[Number(message.tabId)] || null;
                // Local-file GPX jobs belong to the ascent form, not the popup.
                return job && job.provider !== 'upload' ? publicJob(job) : null;
            }
            case 'GPX_PROCESS_START': return startGpxProcess(message, sender);
            case 'GPX_PROCESS_INVALIDATE': return invalidateGpxSelection(message, sender);
            case 'GPX_PROCESS_APPLY': return applyGpxProcess(message, sender);
            case 'CAPTURE_CANCEL': return cancelCapture(message);
            case 'CAPTURE_CLEAR': return clearCapture(message);
            case 'CAPTURE_SELECTION': return publicJob(await updateSelection(message));
            case 'CAPTURE_OPEN_DRAFTS': return openDrafts(message);
            case 'DRAFT_READY': return draftReady(message, sender);
            case 'DRAFT_PREVIEW_STARTED': return previewStarted(message, sender);
            case 'DRAFT_DAY_STATS_APPLIED': return dayStatsApplied(message, sender);
            case TrustedActions.ISSUE_TYPE: return trustedActions.issue(message, sender);
            case TrustedActions.BEGIN_TYPE: return trustedActions.begin(message, sender);
            case TrustedActions.END_TYPE: return trustedActions.end(message, sender);
            case TerrainActivation.ISSUE_TYPE: return terrainActivation.issue(message, sender);
            case TerrainActivation.CONSUME_TYPE: return terrainActivation.consumeFrame(message, sender);
            case 'TERRAIN_PREFETCH': return terrainPrefetch.handle(message, sender);
            default: return null;
            }
        };
        run().then(sendResponse).catch(error => {
            sendResponse({
                phase: 'error',
                error: publicFailure(`runtime route ${message?.type || 'unknown'}`, error, PublicErrors.DEFAULT_ERROR)
            });
        });
        return true;
    });

    const cleanupRemovedTab = async tabId => {
        const removedDraft = await mutateMap(DRAFTS_KEY, drafts => {
            const value = drafts[tabId] || null;
            delete drafts[tabId];
            return value;
        });
        const remainingDrafts = await readMap(DRAFTS_KEY);
        const nextDraft = removedDraft && !removedDraft.complete
                && !orderedDrafts(remainingDrafts, removedDraft.jobId)
                    .some(candidate => !candidate.complete && compareDraftOrder(candidate, removedDraft) < 0)
            ? firstPendingDraft(remainingDrafts, removedDraft.jobId)
            : null;
        await mutateMap(JOBS_KEY, jobs => {
            if (jobs[tabId]) {
                const job = jobs[tabId];
                const hasPendingDraft = Object.values(remainingDrafts).some(draft => draft.jobId === job.id);
                if (hasPendingDraft) job.sourceClosed = true;
                else delete jobs[tabId];
            }
            if (removedDraft) {
                const sourceJob = Object.values(jobs).find(job => job.id === removedDraft.jobId);
                const hasSiblingDraft = Object.values(remainingDrafts).some(draft => draft.jobId === removedDraft.jobId);
                if (sourceJob && !hasSiblingDraft) {
                    if (sourceJob.sourceClosed) delete jobs[sourceJob.sourceTabId];
                    else if (sourceJob.uploadGpx) {
                        sourceJob.phase = 'ready';
                        sourceJob.openedDraftTabIds = [];
                        sourceJob.updatedAt = now();
                    }
                }
            }
        });
        await notifyDraftToProceed(nextDraft);
    };

    ext.tabs.onRemoved.addListener(tabId => {
        terrainActivation.forgetTab(tabId);
        terrainPrefetch.forgetTab(tabId);
        runDetachedCleanup('trusted action cleanup', () => trustedActions.forgetTab(tabId));
        runDetachedCleanup('photo tab cleanup', () => photoRoutes.forgetTab(tabId));
        runDetachedCleanup('report draft tab cleanup', () => reportDraftRoutes.forgetTab(tabId));
        runDetachedCleanup('capture tab cleanup', async () => {
            const [drafts, jobs] = await Promise.all([readMap(DRAFTS_KEY), readMap(JOBS_KEY)]);
            const sourceTabId = Number(drafts[tabId]?.sourceTabId ?? (jobs[tabId] ? tabId : NaN));
            if (!Number.isInteger(sourceTabId)) return;
            abortOwnedWork(sourceTabId, jobs[sourceTabId]?.id ?? null);
            invalidateLifecycle(sourceTabId);
            await serializeLifecycle(sourceTabId, () => cleanupRemovedTab(tabId));
        });
    });

    // Register synchronously: a storage event can be the event that wakes the
    // MV3 worker. Only the favorites value is watched, so backup-state writes
    // cannot trigger themselves.
    ext.storage.onChanged.addListener(githubRoutes.onStorageChanged);

    // The alarm is replaced on each change, producing a durable trailing-edge
    // debounce. Nudging favorites here makes enabling its toggle create the
    // first backup; equal signatures make other settings changes free.
    Settings.subscribe(githubRoutes.onSettingsChanged);
    runDetachedCleanup('photo backup watchdog startup', () =>
        githubRoutes.startPhotoBackupWatchdog());

    if (ext.alarms) {
        ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
        ext.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === CLEANUP_ALARM) {
                runDetachedCleanup('expired capture cleanup', cleanup);
            }
            githubRoutes.onAlarm(alarm.name);
        });
    }
})();
