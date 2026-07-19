// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Garmin/Strava capture coordinator. Long-lived state contains only the reduced
// privacy upload and derived ascent values, and lives in storage.session.

// The worker ships as one bundle; capture-core and settings (and their own
// transitive deps: gpx-metrics, settings-schema) resolve through these imports.
import { captureCore as Core } from './capture-core.js';
import { providerFromUrl } from './provider-url.js';
import { settings as Settings } from './settings.js';
import { githubAuth as GithubAuth } from './github-auth.js';
import { githubClient as GithubClient } from './github-client.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const JOBS_KEY = 'bpbCaptureJobs';
    const DRAFTS_KEY = 'bpbDraftTabs';
    const JOB_TTL_MS = 30 * 60 * 1000;
    // Save-time GitHub backup snapshots, keyed by climber+peak+date, expiring on
    // the same 30-minute horizon as a prepared draft.
    const SNAPSHOTS_KEY = 'bpbGithubSnapshots';
    const GITHUB_AUTH_PENDING_KEY = 'bpbGithubAuthPending';
    const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
    const SNAPSHOT_LIMIT = 10;
    const CLEANUP_ALARM = 'bpb-capture-cleanup';
    const processes = new Map();
    let mutationQueue = Promise.resolve();

    const now = () => Date.now();
    const makeId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const storage = () => {
        if (!ext.storage.session) throw new Error('This browser does not provide private session storage.');
        return ext.storage.session;
    };

    const readCapturePreferences = async () => {
        const settings = await Settings.get();
        return {
            retainWaypoints: settings.retainWaypoints,
            fillAscentDetails: settings.fillAscentDetails,
            fillTripInfo: settings.fillTripInfo,
            fillWildernessNights: settings.fillWildernessNights
        };
    };

    const sameCapturePreferences = (left, right) => !!left && !!right
        && left.retainWaypoints === right.retainWaypoints
        && left.fillAscentDetails === right.fillAscentDetails
        && left.fillTripInfo === right.fillTripInfo
        && left.fillWildernessNights === right.fillWildernessNights;

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

    const publicJob = job => job ? {
        ...job,
        hasCachedGpx: typeof job.uploadGpx === 'string' && job.uploadGpx.length > 0,
        uploadGpx: undefined,
        capturePreferences: undefined,
        tripName: undefined,
        nightsOut: undefined,
        dayStats: undefined,
        matches: (job.matches || []).map(match => ({ ...match, draftFields: undefined }))
    } : null;

    const setBadge = async (tabId, text = '', color = '#b42318') => {
        await ext.action.setBadgeBackgroundColor({ tabId, color });
        await ext.action.setBadgeText({ tabId, text });
    };

    const updateJob = (tabId, patch) => mutateMap(JOBS_KEY, jobs => {
        if (!jobs[tabId]) return null;
        jobs[tabId] = { ...jobs[tabId], ...patch, updatedAt: now() };
        return jobs[tabId];
    });

    const failJob = async (tabId, code, message) => {
        if (code === 'not-owner') await setBadge(tabId, '!', '#b42318');
        else if (code === 'ownership-unverified' || code === 'provider-signed-out') await setBadge(tabId, '!', '#b54708');
        return updateJob(tabId, { phase: 'error', error: { code, message } });
    };

    const finishWithoutGps = async (tabId, message) => {
        await setBadge(tabId, '');
        return updateJob(tabId, {
            phase: 'no-gps',
            matches: [],
            selectedIds: [],
            trackSummary: null,
            uploadGpx: null,
            error: null,
            message: message || 'This activity has no recorded route to capture.',
            expiresAt: now() + JOB_TTL_MS
        });
    };

    const peakbaggerLogin = async () => {
        let response;
        try {
            response = await fetch('https://peakbagger.com/Default.aspx', { credentials: 'include', redirect: 'follow' });
        } catch (_error) {
            throw new Error('Could not reach Peakbagger to verify your login.');
        }
        if (!response.ok) throw new Error(`Peakbagger login check failed with HTTP ${response.status}.`);
        const html = await response.text();
        const match = /href=["'][^"']*\bcid=(\d+)[^"']*["'][^>]*>[\s\S]{0,80}?My Home Page/i.exec(html)
            || /href=["'][^"']*\/climber\/(?:climberedit|ascentedit)\.aspx\?[^"']*\bcid=(\d+)[^"']*["'][^>]*>[\s\S]{0,80}?(?:Edit Account|Add Ascent)/i.exec(html);
        return match ? match[1] : null;
    };

    const fetchBox = async box => {
        const params = new URLSearchParams({
            miny: String(box.miny),
            maxy: String(box.maxy),
            minx: String(box.minx),
            maxx: String(box.maxx)
        });
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(`https://peakbagger.com/Async/pllbb2.aspx?${params}`, {
                    credentials: 'include',
                    redirect: 'follow'
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                if (/<html\b/i.test(text)) throw new Error('unexpected HTML response');
                return text;
            } catch (error) {
                lastError = error;
            }
        }
        throw new Error(`Peakbagger summit lookup failed after retry: ${lastError.message}`);
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

    const fetchPeaks = async boxes => {
        const responses = await mapWithConcurrency(boxes, 4, fetchBox);
        const byId = new Map();
        responses.forEach(text => Core.parsePeakbaggerPeaks(text).forEach(peak => byId.set(peak.id, peak)));
        return [...byId.values()];
    };

    const injectProvider = tabId => ext.scripting.executeScript({
        target: { tabId },
        files: ['provider-page.js'],
        world: 'MAIN'
    });

    const inspectProviderOwnership = async tabId => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            func: () => globalThis.BPBProviderPage.inspectOwnership(),
            world: 'MAIN'
        });
        if (!results || !results[0]) throw new Error('The activity page returned no ownership result.');
        return results[0].result;
    };

    const captureProvider = async (tabId, capturePreferences) => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            func: async options => {
                try {
                    return await globalThis.BPBProviderPage.capture(options);
                } catch (error) {
                    return {
                        ok: false,
                        code: 'provider-export-failed',
                        message: typeof error?.message === 'string' && error.message
                            ? error.message
                            : 'The activity page could not export its GPX.'
                    };
                }
            },
            args: [{
                retainWaypoints: capturePreferences.retainWaypoints,
                includeTripName: capturePreferences.fillTripInfo
            }],
            world: 'MAIN'
        });
        if (!results || !results[0]) throw new Error('The activity page returned no capture result.');
        return results[0].result;
    };

    const processCapture = async (tabId, expectedUrl, capturePreferences) => {
        try {
            const tab = await ext.tabs.get(tabId);
            if (!tab.url || tab.url !== expectedUrl) {
                await failJob(tabId, 'page-changed', 'The active tab changed before capture started.');
                return;
            }

            await updateJob(tabId, { phase: 'checking-ownership' });
            await injectProvider(tabId);
            const ownership = await inspectProviderOwnership(tabId);
            if (!ownership || !ownership.ok) {
                const messages = {
                    unsupported: 'Open a Garmin Connect or Strava activity first.',
                    'provider-signed-out': 'Sign in to the activity provider before capturing.',
                    'not-owner': 'This activity was recorded by another account, so it cannot be captured.',
                    'ownership-unverified': 'Ownership could not be verified from this activity page. Nothing was captured.'
                };
                await failJob(tabId, ownership?.code || 'capture-failed', messages[ownership?.code] || 'The activity could not be captured.');
                return;
            }

            await updateJob(tabId, { phase: 'checking-peakbagger' });
            const cid = await peakbaggerLogin();
            if (!cid) {
                await failJob(tabId, 'peakbagger-signed-out', 'Your Peakbagger login could not be verified. Open Peakbagger, confirm you’re signed in, then try again.');
                return;
            }

            const capture = await captureProvider(tabId, capturePreferences);
            if (!capture || !capture.ok) {
                if (capture?.code === 'no-gps-data') {
                    await finishWithoutGps(tabId, capture.message);
                    return;
                }
                const messages = {
                    'provider-signed-out': 'Sign in to the activity provider before capturing.',
                    'not-owner': 'This activity was recorded by another account, so it cannot be captured.',
                    'ownership-unverified': 'Ownership could not be verified from this activity page. Nothing was captured.',
                    'provider-export-failed': 'The activity provider could not export this GPX. Reload the activity and try again.'
                };
                await failJob(
                    tabId,
                    capture?.code || 'capture-failed',
                    capture?.message || messages[capture?.code] || 'The activity could not be captured.'
                );
                return;
            }
            await setBadge(tabId, '');

            await updateJob(tabId, { phase: 'analyzing' });
            const sanitized = Core.sanitizeTrack(capture.segments);
            const waypoints = capturePreferences.retainWaypoints
                ? Core.sanitizeWaypoints(capture.waypoints)
                : [];
            const pointCount = sanitized.segments.reduce((sum, segment) => sum + segment.length, 0);
            if (pointCount === 0) {
                await finishWithoutGps(tabId, 'The exported activity contains no usable route coordinates.');
                return;
            }
            if (pointCount < 2) throw new Error('The exported GPX contains fewer than two usable track points.');
            if (sanitized.segments.length > Core.MAX_TRACK_SEGMENTS) {
                throw new Error(`The sanitized track has ${sanitized.segments.length} segments; Peakbagger allows 50.`);
            }

            const boxes = Core.buildQueryBoxes(sanitized.segments);
            if (!boxes.length) throw new Error('No valid path remained for summit lookup.');
            await updateJob(tabId, { phase: 'finding-peaks', queryCount: boxes.length });
            const peaks = await fetchPeaks(boxes);
            const allMatches = Core.detectPeaks(sanitized.segments, peaks, sanitized.quality.score);
            const visibleMatches = allMatches.filter(match => match.classification === 'strong' || match.classification === 'probable');
            if (!visibleMatches.length) {
                await updateJob(tabId, {
                    phase: 'no-matches',
                    matches: [],
                    selectedIds: [],
                    trackSummary: { originalPointCount: pointCount, removedPrivateData: true },
                    uploadGpx: null,
                    error: null,
                    expiresAt: now() + JOB_TTL_MS
                });
                return;
            }
            const trackPointLimit = Core.MAX_UPLOAD_POINTS - waypoints.length;
            if (trackPointLimit < 2) {
                const error = new Error(`The GPX has ${waypoints.length} waypoints, leaving no room for a usable track within Peakbagger’s 3,000-point limit.`);
                error.code = 'too-many-waypoints';
                throw error;
            }
            const reduced = Core.reduceTrack(sanitized.segments, visibleMatches, trackPointLimit);
            const uploadGpx = Core.serializeUploadGpx(reduced.segments, waypoints);
            const matches = visibleMatches.map(match => ({
                ...Core.publicMatch(match),
                draftFields: Core.calculateDraftFields(sanitized.segments, match, capture.metadata)
            }));
            const rawTripName = typeof capture.metadata?.title === 'string' ? capture.metadata.title : '';
            const tripName = capturePreferences.fillTripInfo && matches.length > 1
                ? rawTripName.replace(/\s+/g, ' ').trim().slice(0, 200)
                : '';
            const nightsOut = Core.calculateNightsOut(sanitized.segments, capture.metadata);
            const dayStats = capturePreferences.fillAscentDetails
                ? Core.calculateDayStats(sanitized.segments, capture.metadata)
                : [];

            await updateJob(tabId, {
                phase: matches.length ? 'ready' : 'no-matches',
                cid,
                provider: capture.provider,
                activityId: capture.activityId,
                matches,
                selectedIds: matches.filter(match => match.selected).map(match => match.id),
                trackSummary: {
                    originalPointCount: reduced.originalPointCount,
                    retainedPointCount: reduced.retainedPointCount,
                    retainedWaypointCount: waypoints.length,
                    maxDeviationM: reduced.maxDeviationM,
                    removedPrivateData: true,
                    breakCounts: sanitized.quality
                },
                tripName,
                nightsOut,
                dayStats,
                uploadGpx,
                error: null,
                expiresAt: now() + JOB_TTL_MS
            });
        } catch (error) {
            await failJob(tabId, error.code || 'capture-failed', error.message || 'Capture failed.');
        } finally {
            processes.delete(tabId);
        }
    };

    const startCapture = async message => {
        const tabId = Number(message.tabId);
        const tab = await ext.tabs.get(tabId);
        const capturePreferences = await readCapturePreferences();
        const activity = providerFromUrl(tab.url);
        if (!activity) {
            await setBadge(tabId, '');
            return { phase: 'error', error: { code: 'unsupported', message: 'Open a Garmin Connect or Strava activity first.' } };
        }
        const jobs = await readMap(JOBS_KEY);
        const current = jobs[tabId];
        const sameActivity = current && current.provider === activity.provider && current.activityId === activity.activityId;
        if (processes.has(tabId)) {
            await processes.get(tabId);
            const completed = (await readMap(JOBS_KEY))[tabId];
            const completedSameActivity = completed && completed.provider === activity.provider
                && completed.activityId === activity.activityId;
            if (completedSameActivity && sameCapturePreferences(completed.capturePreferences, capturePreferences)) {
                return publicJob(completed);
            }
        }
        const terminalPhases = new Set(['ready', 'no-matches', 'no-gps', 'error', 'opened', 'previewed']);
        if (!message.force && sameActivity && sameCapturePreferences(current.capturePreferences, capturePreferences)
            && current.expiresAt > now() && terminalPhases.has(current.phase)) {
            return publicJob(current);
        }
        await setBadge(tabId, '');

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
        await mutateMap(JOBS_KEY, map => { map[tabId] = job; });
        const process = processCapture(tabId, tab.url, capturePreferences);
        processes.set(tabId, process);
        await process;
        return publicJob((await readMap(JOBS_KEY))[tabId]);
    };

    const clearCapture = async message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) throw new Error('Activity tab identity is unavailable.');
        if (processes.has(tabId)) throw new Error('Wait for the current capture to finish before discarding it.');
        const tab = await ext.tabs.get(tabId);
        const activity = providerFromUrl(tab.url);
        if (!activity) throw new Error('Open the captured Garmin or Strava activity before discarding it.');

        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!job) return { ok: true, removedGpx: false, removedDraftCount: 0 };
        if (job.provider !== activity.provider || job.activityId !== activity.activityId) {
            throw new Error('The cached capture belongs to a different activity. Reopen the popup and try again.');
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

    const updateSelection = async message => {
        const tabId = Number(message.tabId);
        return mutateMap(JOBS_KEY, jobs => {
            const job = jobs[tabId];
            if (!job || (job.phase !== 'ready' && job.phase !== 'opened')) return null;
            const allowed = new Set(job.matches.map(match => String(match.id)));
            job.selectedIds = [...new Set((message.selectedIds || []).map(String))]
                .filter(id => allowed.has(id))
                .map(Number);
            job.updatedAt = now();
            return job;
        });
    };

    const openDrafts = async message => {
        const tabId = Number(message.tabId);
        await updateSelection(message);
        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!job || !job.uploadGpx || (job.phase !== 'ready' && job.phase !== 'opened')) {
            throw new Error('Capture results are no longer available. Capture the activity again.');
        }
        const selectedWithSuffixes = Core.assignDraftSuffixes(job.matches
            .filter(match => job.selectedIds.includes(match.id)));
        if (!selectedWithSuffixes.length) throw new Error('Select at least one detected peak.');
        const trackOrdered = selectedWithSuffixes.map((match, index) => ({ match, index }))
            .sort((left, right) => {
                const distance = left.match.draftFields.upDistanceM - right.match.draftFields.upDistanceM;
                return Number.isFinite(distance) && distance !== 0 ? distance : left.index - right.index;
            })
            .map(({ match }) => match);
        const sequenceById = new Map(trackOrdered.map((match, index) => [String(match.id), index + 1]));
        const fallbackTripName = trackOrdered.map(match => match.name).join(' / ').slice(0, 200);
        const useTripInfo = job.capturePreferences?.fillTripInfo && selectedWithSuffixes.length > 1;
        const useWildernessNights = job.capturePreferences?.fillWildernessNights
            && Number.isInteger(job.nightsOut) && job.nightsOut > 0;
        const selected = selectedWithSuffixes.sort((a, b) => b.confidence - a.confidence);

        const existingDrafts = await readMap(DRAFTS_KEY);
        const existingForJob = Object.values(existingDrafts)
            .filter(draft => draft.jobId === job.id)
            .sort((a, b) => b.confidence - a.confidence);
        if (existingForJob.length) {
            for (const draft of existingForJob) await ext.tabs.update(draft.tabId, { active: false });
            await ext.tabs.update(existingForJob[0].tabId, { active: true });
            return { tabIds: existingForJob.map(draft => draft.tabId), reused: true };
        }

        const sourceTab = await ext.tabs.get(tabId);
        const created = [];
        for (let index = 0; index < selected.length; index++) {
            const match = selected[index];
            const tab = await ext.tabs.create({ url: 'about:blank', active: false, windowId: sourceTab.windowId });
            const draft = {
                tabId: tab.id,
                jobId: job.id,
                sourceTabId: tabId,
                pid: match.id,
                cid: job.cid,
                classification: match.classification,
                confidence: match.confidence,
                suffix: match.draftFields.suffix,
                tripInfo: useTripInfo ? {
                    sequence: sequenceById.get(String(match.id)),
                    name: job.tripName || fallbackTripName,
                    nightsOut: Number.isInteger(job.nightsOut) ? job.nightsOut : null
                } : null,
                wildernessNightsOut: useWildernessNights ? job.nightsOut : null,
                previewOrder: index,
                previewStarted: false,
                complete: false,
                dayStatsPending: false,
                focusOnReady: index === 0,
                expiresAt: now() + JOB_TTL_MS
            };
            await mutateMap(DRAFTS_KEY, drafts => { drafts[tab.id] = draft; });
            created.push(draft);
        }

        const tabIds = created.map(draft => draft.tabId);
        let groupWarning = null;
        try {
            const groupId = await ext.tabs.group({ tabIds, createProperties: { windowId: sourceTab.windowId } });
            await ext.tabGroups.update(groupId, { title: 'Peak Drafts', color: 'green', collapsed: false });
        } catch (error) {
            groupWarning = `Drafts opened, but tab grouping failed: ${error.message}`;
        }
        await Promise.all(created.map(draft => ext.tabs.update(draft.tabId, {
            url: `https://peakbagger.com/climber/ascentedit.aspx?pid=${draft.pid}&cid=${draft.cid}`,
            active: false
        })));
        await updateJob(tabId, { phase: 'opened', openedDraftTabIds: tabIds, groupWarning });
        return { tabIds, groupWarning, reused: false };
    };

    const validateDraftPage = (draft, message) => String(draft.pid) === String(message.pid)
        && String(draft.cid) === String(message.cid);

    const draftOrder = draft => Number.isInteger(draft.previewOrder) ? draft.previewOrder : Number(draft.tabId);
    const compareDraftOrder = (left, right) => draftOrder(left) - draftOrder(right);
    const orderedDrafts = (drafts, jobId) => Object.values(drafts)
        .filter(candidate => candidate.jobId === jobId)
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

    const draftReady = async (message, sender) => {
        const tabId = sender.tab?.id;
        if (!Number.isInteger(tabId)) return { action: 'error', message: 'Draft tab identity is unavailable.' };
        const drafts = await readMap(DRAFTS_KEY);
        const draft = drafts[tabId];
        if (!draft) return { action: 'ignore' };
        if (!validateDraftPage(draft, message)) {
            return { action: 'error', message: 'This Peakbagger page does not match its prepared ascent draft.' };
        }
        const jobs = await readMap(JOBS_KEY);
        const job = Object.values(jobs).find(candidate => candidate.id === draft.jobId);
        if (!job) return { action: 'error', message: 'The private draft data expired. Capture the activity again.' };
        const match = job.matches.find(candidate => candidate.id === draft.pid);
        if (!match) return { action: 'error', message: 'The selected peak is no longer available.' };

        if (draft.complete) {
            return {
                action: 'banner',
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
                    if (!map[tabId]) return;
                    map[tabId].previewStarted = false;
                    map[tabId].previewError = result.message || 'Peakbagger returned no success confirmation.';
                });
                const explanation = result.state === 'error' && result.message
                    ? `Peakbagger rejected GPS Preview: ${result.message}`
                    : 'Peakbagger did not confirm that GPS Preview succeeded.';
                return {
                    action: 'preview-error',
                    message: `${explanation} The GPX and draft were kept.`
                };
            }
            await mutateMap(DRAFTS_KEY, map => {
                if (!map[tabId]) return;
                map[tabId].complete = true;
                map[tabId].previewError = null;
                map[tabId].dayStatsPending = job.capturePreferences?.fillAscentDetails !== false
                    && Array.isArray(job.dayStats) && job.dayStats.length > 1;
            });
            const currentDrafts = await readMap(DRAFTS_KEY);
            const nextDraft = firstPendingDraft(currentDrafts, draft.jobId);
            if (nextDraft) await notifyDraftToProceed(nextDraft);
            else await updateJob(draft.sourceTabId, { phase: 'previewed', uploadGpx: null });
            const completedDraft = currentDrafts[tabId];
            return {
                action: 'banner',
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
            return { action: 'wait', message: 'Waiting for the previous GPS Preview to finish.' };
        }

        if (draft.focusOnReady) {
            await ext.tabs.update(tabId, { active: true });
            await mutateMap(DRAFTS_KEY, map => { if (map[tabId]) map[tabId].focusOnReady = false; });
        }
        return {
            action: 'apply',
            jobId: job.id,
            pid: draft.pid,
            cid: draft.cid,
            classification: draft.classification,
            confidence: draft.confidence,
            fields: {
                ...match.draftFields,
                suffix: draft.suffix || '',
                fillAscentDetails: job.capturePreferences?.fillAscentDetails !== false,
                dayStats: job.dayStats || [],
                tripInfo: draft.tripInfo || null,
                wildernessNightsOut: draft.wildernessNightsOut ?? null
            },
            allowWaypoints: !!job.capturePreferences?.retainWaypoints,
            gpx: job.uploadGpx
        };
    };

    const previewStarted = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            const currentDraft = draft ? firstPendingDraft(drafts, draft.jobId) : null;
            if (!draft || currentDraft?.tabId !== tabId || draft.jobId !== message.jobId
                || !validateDraftPage(draft, message) || draft.previewStarted || draft.complete) {
                return { ok: false };
            }
            draft.previewStarted = true;
            draft.expiresAt = now() + JOB_TTL_MS;
            return { ok: true };
        });
    };

    const dayStatsApplied = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            if (!draft || !draft.complete || !draft.dayStatsPending || draft.jobId !== message.jobId
                || !validateDraftPage(draft, message)) return { ok: false };
            draft.dayStatsPending = false;
            draft.expiresAt = now() + JOB_TTL_MS;
            return { ok: true };
        });
    };

    const cleanup = async () => {
        const cutoff = now();
        const drafts = await mutateMap(DRAFTS_KEY, map => {
            Object.entries(map).forEach(([tabId, draft]) => {
                if (draft.expiresAt <= cutoff) delete map[tabId];
            });
            return { ...map };
        });
        const activeJobIds = new Set(Object.values(drafts).map(draft => draft.jobId));
        await mutateMap(JOBS_KEY, jobs => {
            Object.entries(jobs).forEach(([tabId, job]) => {
                if (job.expiresAt <= cutoff && !activeJobIds.has(job.id)) delete jobs[tabId];
            });
        });
        await mutateMap(SNAPSHOTS_KEY, snapshots => {
            Object.entries(snapshots).forEach(([key, record]) => {
                if (!record || record.expiresAt <= cutoff) delete snapshots[key];
            });
        });
    };

    // ---- GitHub ascent backup: auth + repository setup ---------------------
    //
    // The token lives only here (via GithubAuth.authStore over storage.local)
    // and is never returned to any page. The device-flow poll is driven in the
    // worker; the options page shows the user code and advances a persisted,
    // one-request-at-a-time poll through GITHUB_AUTH_STATE. Repo scoping happens
    // on GitHub's own install page, then discovery lists exactly what the token
    // can reach.

    const netFetch = (url, init) => fetch(url, init);
    const readPendingGithubAuth = async () => (await storage().get(GITHUB_AUTH_PENDING_KEY))[GITHUB_AUTH_PENDING_KEY] || null;
    const writePendingGithubAuth = pending => storage().set({ [GITHUB_AUTH_PENDING_KEY]: pending });
    const clearPendingGithubAuth = () => storage().remove(GITHUB_AUTH_PENDING_KEY);
    const publicGithubAuthState = pending => ({
        phase: 'polling',
        userCode: pending.userCode,
        verificationUri: pending.verificationUri,
        verificationUriComplete: pending.verificationUriComplete,
        expiresIn: pending.expiresIn,
        startedAt: pending.startedAt,
    });

    // Only extension-owned pages (the options page) may touch the auth surface;
    // a content script's sender.url is a web origin, never the extension origin.
    const isExtensionPage = sender => {
        try { return !!(sender && sender.url && sender.url.startsWith(ext.runtime.getURL(''))); }
        catch { return false; }
    };

    const githubStatus = async () => {
        const auth = await GithubAuth.authStore.read();
        const settings = await Settings.get();
        return {
            enabled: settings.enableGithubBackup,
            auto: settings.autoGithubBackup,
            connected: !!(auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name),
            hasToken: !!(auth && auth.token),
            account: (auth && auth.account) || null,
            repo: (auth && auth.repo) || null,
            installUrl: GithubAuth.INSTALL_URL,
            appUrl: GithubAuth.APP_URL,
            verificationUri: GithubAuth.VERIFICATION_URI,
        };
    };

    // Auto-select the sole granted repo (zero-typing setup); several or none
    // leave the choice to the user.
    const applyDiscoveredRepos = async repos => {
        if (repos.length === 1) {
            const r = repos[0];
            await GithubAuth.authStore.setRepo({ owner: r.owner, name: r.name, branch: r.defaultBranch, id: r.id, fullName: r.fullName });
            await GithubAuth.authStore.setInstallationId(r.installationId);
        }
    };

    const githubBeginAuth = async () => {
        await clearPendingGithubAuth();
        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        let code;
        try {
            code = await flow.requestCode();
        } catch (error) {
            return { phase: 'error', code: error.code || 'unknown' };
        }
        const startedAt = now();
        const pending = {
            deviceCode: code.deviceCode,
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            verificationUriComplete: code.verificationUriComplete,
            expiresIn: code.expiresIn,
            interval: Math.max(1, Number(code.interval) || 5),
            startedAt,
            expiresAt: startedAt + code.expiresIn * 1000,
            nextPollAt: startedAt + Math.max(1, Number(code.interval) || 5) * 1000,
        };
        await writePendingGithubAuth(pending);
        return publicGithubAuthState(pending);
    };

    const githubPollAuth = async () => {
        const pending = await readPendingGithubAuth();
        if (!pending) return { phase: 'idle' };
        if (now() > pending.expiresAt) {
            await clearPendingGithubAuth();
            return { phase: 'error', code: 'expired' };
        }
        if (now() < pending.nextPollAt) return publicGithubAuthState(pending);

        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        try {
            const result = await flow.pollTokenOnce(pending);
            if (result.phase === 'pending' || result.phase === 'slow-down') {
                const interval = result.phase === 'slow-down'
                    ? Math.max(pending.interval + 5, result.interval)
                    : pending.interval;
                const next = { ...pending, interval, nextPollAt: now() + interval * 1000 };
                await writePendingGithubAuth(next);
                return publicGithubAuthState(next);
            }

            const cred = result.credential;
            await GithubAuth.authStore.setCredential(cred);
            let account = null;
            try { account = await GithubAuth.fetchAccount({ fetch: netFetch, token: cred.token }); await GithubAuth.authStore.setAccount(account); } catch { /* non-fatal */ }
            let repos = [];
            let installationCount = 0;
            try {
                const discovered = await GithubAuth.listBackupRepositories({ fetch: netFetch, token: cred.token });
                repos = discovered.repos;
                installationCount = discovered.installationCount;
                await applyDiscoveredRepos(repos);
            } catch { /* the user may not have installed yet; discover again later */ }
            await clearPendingGithubAuth();
            return { phase: 'authorized', account, repos, installationCount };
        } catch (error) {
            await clearPendingGithubAuth();
            return { phase: 'error', code: (error && error.code) || 'unknown' };
        }
    };

    // Re-list repositories on demand — after the user returns from the install
    // page having granted (or changed) the selected repositories.
    const githubDiscoverRepos = async () => {
        const token = await GithubAuth.authStore.getToken();
        if (!token) return { phase: 'error', code: 'no-token' };
        try {
            const { repos, installationCount } = await GithubAuth.listBackupRepositories({ fetch: netFetch, token });
            await applyDiscoveredRepos(repos);
            return { installationCount, repos, repo: await GithubAuth.authStore.getRepo() };
        } catch (error) {
            return { phase: 'error', code: error.code || 'unknown' };
        }
    };

    const githubSelectRepo = async message => {
        const r = message && message.repo;
        if (!r || !r.owner || !r.name) return { error: 'invalid-repo' };
        await GithubAuth.authStore.setRepo({ owner: r.owner, name: r.name, branch: r.branch || r.defaultBranch || 'main', id: r.id ?? null, fullName: r.fullName || `${r.owner}/${r.name}` });
        if (r.installationId != null) await GithubAuth.authStore.setInstallationId(r.installationId);
        return githubStatus();
    };

    const githubDisconnect = async () => {
        await clearPendingGithubAuth();
        await GithubAuth.authStore.clear();
        return githubStatus();
    };

    const isPeakbaggerSender = sender => {
        try {
            return !!(sender && sender.tab && sender.url && /(^|\.)peakbagger\.com$/i.test(new URL(sender.url).hostname));
        } catch { return false; }
    };

    // The save-time snapshot from the ascentedit content script: keep it in
    // storage.session, keyed by identity, for the saved ascent page to back up.
    // Accepted only from a Peakbagger tab and only while the feature is enabled;
    // the cleanup alarm expires it on the 30-minute horizon.
    const storeBackupSnapshot = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, reason: 'forbidden' };
        if (!message || !message.key || !message.snapshot) return { ok: false, reason: 'invalid' };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, reason: 'disabled' };
        await mutateMap(SNAPSHOTS_KEY, snapshots => {
            snapshots[message.key] = {
                identity: message.identity || null,
                snapshot: message.snapshot,
                sourceTabId: sender.tab ? sender.tab.id : null,
                savedAt: now(),
                expiresAt: now() + SNAPSHOT_TTL_MS,
            };
            const ordered = Object.entries(snapshots).sort((a, b) => b[1].savedAt - a[1].savedAt);
            for (const [key] of ordered.slice(SNAPSHOT_LIMIT)) delete snapshots[key];
        });
        return { ok: true };
    };

    // Whether the saved ascent page should offer a backup: enabled and connected.
    // Content-script safe — it exposes no token, only the flags and repo name.
    const githubBackupStatus = async sender => {
        if (!isPeakbaggerSender(sender)) return { enabled: false, connected: false };
        const settings = await Settings.get();
        const auth = await GithubAuth.authStore.read();
        const connected = !!(auth && auth.token && auth.repo && auth.repo.owner && auth.repo.name);
        return {
            enabled: !!settings.enableGithubBackup,
            auto: !!settings.autoGithubBackup,
            connected,
            repo: connected ? { fullName: auth.repo.fullName || `${auth.repo.owner}/${auth.repo.name}` } : null,
        };
    };

    // Merge the pending save-time snapshot with the saved ascent page's fields.
    // The saved page is authoritative for the identity and the fields it renders
    // (aid, date, suffix, peak name/elevation/location); the snapshot supplies
    // the fields the page does not (the entered numbers) and the resolved report.
    const mergeBackupSnapshot = (snap, page = {}) => {
        const p = page && typeof page === 'object' ? page : {};
        const base = snap && typeof snap === 'object' ? snap : null;
        if (!base && !p.ascent && !p.peak) return null;
        const ascent = { ...(base ? base.ascent : {}) };
        const pAscent = p.ascent || {};
        if (pAscent.id != null) ascent.id = pAscent.id;
        if (pAscent.date) ascent.date = pAscent.date;
        if (typeof pAscent.suffix === 'string' && pAscent.suffix) ascent.suffix = pAscent.suffix;
        const peak = { ...(base && base.peak ? base.peak : {}) };
        for (const [key, value] of Object.entries(p.peak || {})) {
            if (value != null && value !== '') peak[key] = value;
        }
        const snapMarkdown = base && base.report && typeof base.report.markdown === 'string' ? base.report.markdown : '';
        const pageMarkdown = p.report && typeof p.report.markdown === 'string' ? p.report.markdown : '';
        const report = { markdown: snapMarkdown || pageMarkdown };
        return { ascent, peak, report, backup: { ...(base ? base.backup : {}) } };
    };

    // Find the pending snapshot for a saved ascent page. A new ascent had no aid
    // when it was snapshotted, so match by ascent id first (re-saves/edits), then
    // by peak+date, then by peak alone (most recent) when the page date could not
    // be parsed. Returns { key, record } or null.
    const findSnapshotForPage = async (page, { allowPeakOnly = true } = {}) => {
        const snapshots = await readMap(SNAPSHOTS_KEY);
        const entries = Object.entries(snapshots)
            .map(([key, record]) => ({ key, record }))
            .sort((a, b) => (b.record.savedAt || 0) - (a.record.savedAt || 0));
        const idOf = e => e.record.identity || {};
        const ascentId = page && page.ascent ? page.ascent.id : null;
        const peakId = page && page.peak ? page.peak.id : null;
        const date = page && page.ascent ? page.ascent.date : null;
        let match = ascentId != null ? entries.find(e => idOf(e).ascentId === ascentId) : null;
        if (!match && peakId != null && date) match = entries.find(e => idOf(e).peakId === peakId && idOf(e).date === date);
        if (!match && allowPeakOnly && peakId != null) match = entries.find(e => idOf(e).peakId === peakId);
        return match || null;
    };

    // Push one saved ascent to the connected repository as a single commit. The
    // token is read here and never leaves the worker. Fails closed when the
    // feature is off, disconnected, or the sender is not a Peakbagger tab.
    const backupAscent = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, error: { code: 'disabled' } };
        const auth = await GithubAuth.authStore.read();
        if (!auth || !auth.token) return { ok: false, error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) return { ok: false, error: { code: 'no-repo' } };

        const found = await findSnapshotForPage(message.page, { allowPeakOnly: !message.auto });
        // Automatic backup fires on every saved-ascent page load, so it must push
        // only right after a save — i.e. when a matching pending snapshot exists.
        // Without one (an old ascent merely being viewed) it declines quietly so
        // it never re-pushes on a revisit; the manual button is still offered.
        if (message.auto && !found) return { ok: false, error: { code: 'no-fresh-save' } };
        const snapshot = mergeBackupSnapshot(found && found.record.snapshot, message.page);
        if (!snapshot || snapshot.ascent.id == null) return { ok: false, error: { code: 'no-data' } };
        snapshot.backup = {
            ...(snapshot.backup || {}),
            syncedAt: new Date().toISOString(),
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : (snapshot.backup && snapshot.backup.extensionVersion) || '',
        };

        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token: auth.token,
            owner: auth.repo.owner,
            repo: auth.repo.name,
            branch: auth.repo.branch || undefined,
        });
        try {
            const result = await client.pushAscentBackup(snapshot, { gpx: message.gpx });
            // The snapshot has served its purpose; drop it so a later view of the
            // same page does not re-push from stale data.
            if (found) await mutateMap(SNAPSHOTS_KEY, m => { delete m[found.key]; });
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: { code: error.code || 'unknown', message: error.message || 'The backup failed.' } };
        }
    };

    ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const run = async () => {
            await cleanup();
            const type = message?.type;
            // The auth surface is extension-page only; the token never crosses
            // to a content script.
            if (typeof type === 'string' && type.startsWith('GITHUB_AUTH_') && !isExtensionPage(sender)) {
                return { error: 'forbidden' };
            }
            switch (type) {
            case 'GITHUB_AUTH_STATUS': return githubStatus();
            case 'GITHUB_AUTH_BEGIN': return githubBeginAuth();
            case 'GITHUB_AUTH_STATE': return githubPollAuth();
            case 'GITHUB_AUTH_DISCOVER': return githubDiscoverRepos();
            case 'GITHUB_AUTH_SELECT_REPO': return githubSelectRepo(message);
            case 'GITHUB_AUTH_DISCONNECT': return githubDisconnect();
            case 'GITHUB_BACKUP_SNAPSHOT': return storeBackupSnapshot(message, sender);
            case 'GITHUB_BACKUP_STATUS': return githubBackupStatus(sender);
            case 'GITHUB_BACKUP_ASCENT': return backupAscent(message, sender);
            case 'CAPTURE_START': return startCapture(message);
            case 'CAPTURE_STATUS': {
                const jobs = await readMap(JOBS_KEY);
                return publicJob(jobs[Number(message.tabId)] || null);
            }
            case 'CAPTURE_CLEAR': return clearCapture(message);
            case 'CAPTURE_SELECTION': return publicJob(await updateSelection(message));
            case 'CAPTURE_OPEN_DRAFTS': return openDrafts(message);
            case 'DRAFT_READY': return draftReady(message, sender);
            case 'DRAFT_PREVIEW_STARTED': return previewStarted(message, sender);
            case 'DRAFT_DAY_STATS_APPLIED': return dayStatsApplied(message, sender);
            default: return null;
            }
        };
        run().then(sendResponse).catch(error => sendResponse({
            phase: 'error',
            error: { code: error.code || 'unexpected', message: error.message || 'Unexpected extension error.' }
        }));
        return true;
    });

    ext.tabs.onRemoved.addListener(tabId => {
        void (async () => {
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
        })();
    });

    if (ext.alarms) {
        ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
        ext.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === CLEANUP_ALARM) void cleanup();
        });
    }
})();
