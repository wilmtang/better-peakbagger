// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Garmin/Strava capture coordinator. Long-lived state contains only the reduced
// privacy upload and derived ascent values, and lives in storage.session.

if (typeof importScripts === 'function' && !globalThis.BPBCaptureCore) {
    importScripts('capture-core.js');
}

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    const Core = globalThis.BPBCaptureCore;
    if (!ext || !Core) return;

    const JOBS_KEY = 'bpbCaptureJobs';
    const DRAFTS_KEY = 'bpbDraftTabs';
    const JOB_TTL_MS = 30 * 60 * 1000;
    const CLEANUP_ALARM = 'bpb-capture-cleanup';
    const processes = new Map();
    let mutationQueue = Promise.resolve();

    const now = () => Date.now();
    const makeId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const storage = () => {
        if (!ext.storage.session) throw new Error('This browser does not provide private session storage.');
        return ext.storage.session;
    };

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

    const activityFromUrl = urlValue => {
        try {
            const url = new URL(urlValue);
            let match = /^\/app\/activity\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
            if (url.hostname === 'connect.garmin.com' && match) return { provider: 'garmin', activityId: match[1] };
            match = /^\/activities\/(\d+)(?:[/?#]|$)/i.exec(url.pathname);
            if (/(^|\.)strava\.com$/i.test(url.hostname) && match) return { provider: 'strava', activityId: match[1] };
        } catch (_error) {
            // Unsupported/malformed URLs are represented as null.
        }
        return null;
    };

    const publicJob = job => job ? {
        ...job,
        uploadGpx: undefined,
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

    const peakbaggerLogin = async () => {
        let response;
        try {
            response = await fetch('https://peakbagger.com/Default.aspx', { credentials: 'include', redirect: 'follow' });
        } catch (_error) {
            throw new Error('Could not reach Peakbagger to verify your login.');
        }
        if (!response.ok) throw new Error(`Peakbagger login check failed with HTTP ${response.status}.`);
        const html = await response.text();
        const match = /href=["'][^"']*\bcid=(\d+)[^"']*["'][^>]*>[\s\S]{0,80}?My Home Page/i.exec(html);
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
        files: ['src/provider-page.js'],
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

    const captureProvider = async tabId => {
        const results = await ext.scripting.executeScript({
            target: { tabId },
            func: () => globalThis.BPBProviderPage.capture(),
            world: 'MAIN'
        });
        if (!results || !results[0]) throw new Error('The activity page returned no capture result.');
        return results[0].result;
    };

    const processCapture = async (tabId, expectedUrl) => {
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
                await failJob(tabId, 'peakbagger-signed-out', 'Sign in to Peakbagger before capturing this activity.');
                return;
            }

            const capture = await captureProvider(tabId);
            if (!capture || !capture.ok) {
                await failJob(tabId, capture?.code || 'capture-failed', 'Ownership changed before the GPX export was fetched. Nothing was captured.');
                return;
            }
            await setBadge(tabId, '');

            await updateJob(tabId, { phase: 'analyzing' });
            const sanitized = Core.sanitizeTrack(capture.segments);
            const pointCount = sanitized.segments.reduce((sum, segment) => sum + segment.length, 0);
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
            const reduced = Core.reduceTrack(sanitized.segments, visibleMatches);
            const uploadGpx = Core.serializeUploadGpx(reduced.segments);
            const matches = visibleMatches.map(match => ({
                ...Core.publicMatch(match),
                draftFields: Core.calculateDraftFields(sanitized.segments, match, capture.metadata)
            }));

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
                    maxDeviationM: reduced.maxDeviationM,
                    removedPrivateData: true,
                    breakCounts: sanitized.quality
                },
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
        const activity = activityFromUrl(tab.url);
        if (!activity) {
            await setBadge(tabId, '');
            return { phase: 'error', error: { code: 'unsupported', message: 'Open a Garmin Connect or Strava activity first.' } };
        }
        const jobs = await readMap(JOBS_KEY);
        const current = jobs[tabId];
        const sameActivity = current && current.provider === activity.provider && current.activityId === activity.activityId;
        if (processes.has(tabId)) {
            await processes.get(tabId);
            return publicJob((await readMap(JOBS_KEY))[tabId]);
        }
        const terminalPhases = new Set(['ready', 'no-matches', 'error', 'opened', 'previewed']);
        if (!message.force && sameActivity && current.expiresAt > now() && terminalPhases.has(current.phase)) {
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
            createdAt: now(),
            updatedAt: now(),
            expiresAt: now() + JOB_TTL_MS,
            error: null
        };
        await mutateMap(JOBS_KEY, map => { map[tabId] = job; });
        const process = processCapture(tabId, tab.url);
        processes.set(tabId, process);
        await process;
        return publicJob((await readMap(JOBS_KEY))[tabId]);
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
        const selected = job.matches
            .filter(match => job.selectedIds.includes(match.id))
            .sort((a, b) => b.confidence - a.confidence);
        if (!selected.length) throw new Error('Select at least one detected peak.');

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
                previewStarted: false,
                complete: false,
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

        if (draft.previewStarted) {
            await mutateMap(DRAFTS_KEY, map => {
                if (map[tabId]) map[tabId].complete = true;
            });
            const currentDrafts = await readMap(DRAFTS_KEY);
            const allComplete = Object.values(currentDrafts)
                .filter(candidate => candidate.jobId === draft.jobId)
                .every(candidate => candidate.complete);
            if (allComplete) await updateJob(draft.sourceTabId, { phase: 'previewed', uploadGpx: null });
            return { action: 'banner', classification: draft.classification, confidence: draft.confidence };
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
            fields: match.draftFields,
            gpx: job.uploadGpx
        };
    };

    const previewStarted = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            if (!draft || draft.jobId !== message.jobId || !validateDraftPage(draft, message) || draft.previewStarted) {
                return { ok: false };
            }
            draft.previewStarted = true;
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
    };

    ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const run = async () => {
            await cleanup();
            switch (message?.type) {
            case 'CAPTURE_START': return startCapture(message);
            case 'CAPTURE_STATUS': {
                const jobs = await readMap(JOBS_KEY);
                return publicJob(jobs[Number(message.tabId)] || null);
            }
            case 'CAPTURE_SELECTION': return publicJob(await updateSelection(message));
            case 'CAPTURE_OPEN_DRAFTS': return openDrafts(message);
            case 'DRAFT_READY': return draftReady(message, sender);
            case 'DRAFT_PREVIEW_STARTED': return previewStarted(message, sender);
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
        })();
    });

    if (ext.alarms) {
        ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
        ext.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === CLEANUP_ALARM) void cleanup();
        });
    }
})();
