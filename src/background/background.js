// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Garmin/Strava capture coordinator. Long-lived state contains only the reduced
// privacy upload and derived ascent values, and lives in storage.session.

// The worker ships as one bundle; capture-core and settings (and their own
// transitive deps: gpx-metrics, settings-schema) resolve through these imports.
import { captureCore as Core } from '../capture/capture-core.js';
import { capturePhases as CapturePhases } from '../capture/capture-phases.js';
import { providerFromUrl, providerActivityUrl } from '../capture/provider-url.js';
import { createGithubRoutes } from './github-routes.js';
import { createTerrainPrefetch } from './terrain-prefetch.js';
import { settings as Settings } from '../settings/settings.js';
import { peakbaggerError as PeakbaggerError } from '../peakbagger/peakbagger-error.js';
import { fetchPeakbaggerResource } from '../peakbagger/peakbagger-request.js';

(() => {
    'use strict';

    const ext = globalThis.browser || globalThis.chrome;
    if (!ext) return;

    const JOBS_KEY = 'bpbCaptureJobs';
    const DRAFTS_KEY = 'bpbDraftTabs';
    const JOB_TTL_MS = 30 * 60 * 1000;
    // Save-time GitHub backup snapshots, keyed by climber+peak+date+source tab,
    // expiring on the same 30-minute horizon as a prepared draft.
    const SNAPSHOTS_KEY = 'bpbGithubSnapshots';
    const CLEANUP_ALARM = 'bpb-capture-cleanup';
    const processes = new Map();
    let mutationQueue = Promise.resolve();
    let githubWriteQueue = Promise.resolve();

    const now = () => Date.now();
    const isFresh = record => !!record && Number(record.expiresAt) > now();
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

    // Every backup surface targets the same mutable branch. Serialize writes
    // within this worker so an automatic save, a manual save, and a profile
    // batch cannot race one another between reading and updating the branch
    // head. External writers are still handled by the GitHub client's bounded
    // optimistic-concurrency retry.
    const enqueueGithubWrite = write => {
        const operation = githubWriteQueue.then(write, write);
        githubWriteQueue = operation.catch(() => {});
        return operation;
    };

    const publicJob = job => isFresh(job) ? {
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
        const response = await fetchPeakbaggerResource('https://peakbagger.com/Default.aspx', { kind: 'html' });
        if (response.kind !== 'ok') throw PeakbaggerError.exception(response.error);
        const html = response.text;
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
            const response = await fetchPeakbaggerResource(
                `https://www.peakbagger.com/Async/pllbb2.aspx?${params}`,
                { kind: 'peaks' }
            );
            if (response.kind === 'ok') return response.text;
            lastError = PeakbaggerError.exception(response.error);
            if (response.kind !== 'transient') break;
        }
        throw lastError;
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

    // Shared post-capture pipeline: sanitize → corridor lookup → detect →
    // reduce → serialize → derive. Used by activity capture and the local-file
    // GPX process flow so drafted values can never diverge between the two.
    // Returns a discriminated result; job bookkeeping stays with the caller.
    // boundPid names the peak the calling page is bound to. When the track
    // encounters it below the visible-match bar, the result carries an
    // explicit closest-approach fallback ("Use ⟨peak⟩ anyway") instead of
    // silently promoting a weak match — detection itself stays fail-closed.
    const analyzeTrack = async ({ segments, waypoints, metadata, capturePreferences, boundPid = null, onPhase = async () => {} }) => {
        const sanitized = Core.sanitizeTrack(segments);
        const cleanWaypoints = capturePreferences.retainWaypoints
            ? Core.sanitizeWaypoints(waypoints)
            : [];
        const pointCount = sanitized.segments.reduce((sum, segment) => sum + segment.length, 0);
        if (pointCount === 0) {
            return { status: 'no-gps', message: 'The exported activity contains no usable route coordinates.' };
        }
        if (pointCount < 2) throw new Error('The exported GPX contains fewer than two usable track points.');
        if (sanitized.segments.length > Core.MAX_TRACK_SEGMENTS) {
            throw new Error(`The sanitized track has ${sanitized.segments.length} segments; Peakbagger allows 50.`);
        }

        const boxes = Core.buildQueryBoxes(sanitized.segments);
        if (!boxes.length) throw new Error('No valid path remained for summit lookup.');
        await onPhase('finding-peaks', { queryCount: boxes.length });
        const peaks = await fetchPeaks(boxes);
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
            const error = new Error(`The GPX has ${cleanWaypoints.length} waypoints, leaving no room for a usable track within Peakbagger’s 3,000-point limit.`);
            error.code = 'too-many-waypoints';
            throw error;
        }
        const anchorMatches = boundBelowBar ? [...visibleMatches, boundBelowBar] : visibleMatches;
        const reduced = Core.reduceTrack(sanitized.segments, anchorMatches, trackPointLimit);
        const uploadGpx = Core.serializeUploadGpx(reduced.segments, cleanWaypoints);
        const matches = visibleMatches.map(match => ({
            ...Core.publicMatch(match),
            draftFields: Core.calculateDraftFields(sanitized.segments, match, metadata)
        }));
        const rawTripName = typeof metadata?.title === 'string' ? metadata.title : '';
        const tripName = capturePreferences.fillTripInfo && matches.length > 1
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
            const analysis = await analyzeTrack({
                segments: capture.segments,
                waypoints: capture.waypoints,
                metadata: capture.metadata,
                capturePreferences,
                onPhase: (phase, extra) => updateJob(tabId, { phase, ...extra })
            });
            if (analysis.status === 'no-gps') {
                await finishWithoutGps(tabId, analysis.message);
                return;
            }
            if (analysis.status === 'no-matches') {
                await updateJob(tabId, {
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

            await updateJob(tabId, {
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
        if (!message.force && sameActivity && sameCapturePreferences(current.capturePreferences, capturePreferences)
            && current.expiresAt > now() && CapturePhases.isTerminal(current.phase)) {
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

    const cancelCapture = async message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) throw new Error('Activity tab identity is unavailable.');
        let cancelled = false;
        let current = null;
        await mutateMap(JOBS_KEY, jobs => {
            current = jobs[tabId] || null;
            if (!current || CapturePhases.isTerminal(current.phase)) return;
            delete jobs[tabId];
            cancelled = true;
        });
        if (cancelled) await setBadge(tabId, '');
        return { ok: cancelled, cancelled, job: cancelled ? null : publicJob(current) };
    };

    const updateSelection = async message => {
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
            complete: false,
            dayStatsPending: false,
            focusOnReady,
            preserveExistingFields,
            expiresAt: now() + JOB_TTL_MS
        });
        return { ...selection, makeDraft };
    };

    const openNewDraftTabs = async ({
        sourceTabId,
        matches,
        makeDraft,
        startOrder = 0,
        focusFirst = false,
        onBeforeNavigate = null,
    }) => {
        const sourceTab = await ext.tabs.get(sourceTabId);
        const created = [];
        for (let index = 0; index < matches.length; index++) {
            const match = matches[index];
            const tab = await ext.tabs.create({ url: 'about:blank', active: false, windowId: sourceTab.windowId });
            const draft = makeDraft(match, {
                tabId: tab.id,
                previewOrder: startOrder + index,
                focusOnReady: focusFirst && index === 0,
            });
            await mutateMap(DRAFTS_KEY, drafts => { drafts[tab.id] = draft; });
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
                groupWarning = `Drafts opened, but tab grouping failed: ${error.message}`;
            }
        }
        if (onBeforeNavigate) await onBeforeNavigate({ created, groupWarning });
        await Promise.all(created.map(draft => ext.tabs.update(draft.tabId, {
            url: `https://peakbagger.com/climber/ascentedit.aspx?pid=${draft.pid}&cid=${draft.cid}`,
            active: false
        })));
        return { created, groupWarning };
    };

    const openDrafts = async message => {
        const tabId = Number(message.tabId);
        await updateSelection(message);
        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!isFresh(job) || !job.uploadGpx || (job.phase !== 'ready' && job.phase !== 'opened')) {
            throw new Error('Capture results are no longer available. Capture the activity again.');
        }
        const opening = prepareDraftOpening(
            job,
            job.matches.filter(match => job.selectedIds.includes(match.id)),
            tabId
        );
        if (!opening.matches.length) throw new Error('Select at least one detected peak.');

        const existingDrafts = await readMap(DRAFTS_KEY);
        const existingForJob = Object.values(existingDrafts)
            .filter(draft => isFresh(draft) && draft.jobId === job.id)
            .sort((a, b) => b.confidence - a.confidence);
        if (existingForJob.length) {
            for (const draft of existingForJob) await ext.tabs.update(draft.tabId, { active: false });
            await ext.tabs.update(existingForJob[0].tabId, { active: true });
            return { tabIds: existingForJob.map(draft => draft.tabId), reused: true };
        }

        const { created, groupWarning } = await openNewDraftTabs({
            sourceTabId: tabId,
            matches: opening.confidenceOrdered,
            makeDraft: opening.makeDraft,
            focusFirst: true,
        });
        const tabIds = created.map(draft => draft.tabId);
        await updateJob(tabId, { phase: 'opened', openedDraftTabIds: tabIds, groupWarning });
        return { tabIds, groupWarning, reused: false };
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

    const startGpxProcess = async (message, sender) => {
        const page = uploadPageIdentity(sender);
        if (!page) {
            return { phase: 'error', error: { code: 'forbidden', message: 'GPX processing is only available on a Peakbagger ascent form.' } };
        }
        const tabId = page.tabId;
        const capturePreferences = await readCapturePreferences();
        const cid = await peakbaggerLogin();
        if (!cid) {
            return { phase: 'error', error: { code: 'peakbagger-signed-out', message: 'Your Peakbagger login could not be verified. Confirm you’re signed in, then try again.' } };
        }
        if (page.cid && String(page.cid) !== String(cid)) {
            return { phase: 'error', error: { code: 'identity-mismatch', message: 'This ascent form belongs to a different Peakbagger account.' } };
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
            error: null
        };
        await mutateMap(JOBS_KEY, map => { map[tabId] = job; });
        const finish = patch => mutateMap(JOBS_KEY, map => {
            if (!map[tabId] || map[tabId].id !== job.id) return null;
            map[tabId] = { ...map[tabId], ...patch, updatedAt: now(), expiresAt: now() + JOB_TTL_MS };
            return map[tabId];
        });

        try {
            const metadata = {
                utcOffsetMinutes: Number.isFinite(message.utcOffsetMinutes) ? Number(message.utcOffsetMinutes) : null,
                title: capturePreferences.fillTripInfo && typeof message.trackName === 'string' ? message.trackName : ''
            };
            const analysis = await analyzeTrack({
                segments: Array.isArray(message.segments) ? message.segments : [],
                waypoints: capturePreferences.retainWaypoints && Array.isArray(message.waypoints) ? message.waypoints : [],
                metadata,
                capturePreferences,
                boundPid: page.pid
            });
            if (analysis.status === 'no-gps') {
                await finish({ phase: 'no-gps', uploadGpx: null, message: analysis.message });
                return { phase: 'no-gps', message: analysis.message };
            }
            if (analysis.status === 'no-matches') {
                await finish({ phase: 'no-matches', trackSummary: analysis.trackSummary, uploadGpx: null });
                return { phase: 'no-matches', boundPid: page.pid };
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
                return { phase: 'error', error: { code: 'superseded', message: 'A newer GPX was chosen for this form; this result was discarded.' } };
            }
            return {
                phase: 'ready',
                jobId: job.id,
                boundPid: page.pid,
                matches: analysis.matches.map(uploadMatchSummary),
                boundFallback: analysis.boundFallback ? {
                    ...uploadMatchSummary(analysis.boundFallback),
                    closestApproachM: analysis.boundFallback.closestApproachM
                } : null
            };
        } catch (error) {
            const failure = { code: error.code || 'process-failed', message: error.message || 'The GPX could not be processed.' };
            await finish({ phase: 'error', error: failure });
            return { phase: 'error', error: failure };
        }
    };

    const applyGpxProcess = async (message, sender) => {
        const page = uploadPageIdentity(sender);
        if (!page) {
            return { ok: false, error: { code: 'forbidden', message: 'GPX processing is only available on a Peakbagger ascent form.' } };
        }
        const tabId = page.tabId;
        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!isFresh(job) || job.provider !== 'upload' || job.id !== message.jobId
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

        const opening = prepareDraftOpening(job, selectedIds.map(id => byId.get(id)), tabId);
        const primaryMatch = primaryId
            ? opening.matches.find(match => String(match.id) === primaryId)
            : null;
        const siblings = opening.confidenceOrdered.filter(match => match !== primaryMatch);

        // Every draft is registered before any tab changes URL, so a fast
        // page load can never race its own identity checks.
        let order = 0;
        if (primaryMatch) {
            const currentDraft = opening.makeDraft(primaryMatch, {
                tabId,
                previewOrder: order++,
                focusOnReady: false,
                preserveExistingFields: true,
            });
            await mutateMap(DRAFTS_KEY, drafts => { drafts[tabId] = currentDraft; });
        }
        let tabIds = [];
        const { groupWarning } = await openNewDraftTabs({
            sourceTabId: tabId,
            matches: siblings,
            makeDraft: opening.makeDraft,
            startOrder: order,
            focusFirst: !primaryMatch,
            onBeforeNavigate: async ({ created: pending, groupWarning: warning }) => {
                tabIds = [...(primaryMatch ? [tabId] : []), ...pending.map(draft => draft.tabId)];
                await updateJob(tabId, { phase: 'opened', openedDraftTabIds: tabIds, groupWarning: warning });
            },
        });
        if (primaryMatch) {
            if (page.pid !== null) {
                await notifyDraftToProceed({ tabId });
            } else {
                // Unbound page: peak selection on the native form is a
                // postback, so the standard draft delivery fills the page
                // this navigation reloads.
                await ext.tabs.update(tabId, {
                    url: `https://peakbagger.com/climber/ascentedit.aspx?pid=${primaryMatch.id}&cid=${job.cid}`
                });
            }
        }
        return { ok: true, tabIds, groupWarning };
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

    const draftReady = async (message, sender) => {
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
                    if (!map[tabId]) return;
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
            await mutateMap(DRAFTS_KEY, map => { if (map[tabId]) map[tabId].focusOnReady = false; });
        }
        return {
            action: 'apply',
            peakName,
            jobId: job.id,
            pid: draft.pid,
            cid: draft.cid,
            classification: draft.classification,
            confidence: draft.confidence,
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

    const previewStarted = async (message, sender) => {
        const tabId = sender.tab?.id;
        return mutateMap(DRAFTS_KEY, drafts => {
            const draft = drafts[tabId];
            const currentDraft = draft ? firstPendingDraft(drafts, draft.jobId) : null;
            if (!isFresh(draft) || currentDraft?.tabId !== tabId || draft.jobId !== message.jobId
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
            if (!isFresh(draft) || !draft.complete || !draft.dayStatsPending || draft.jobId !== message.jobId
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
        await githubRoutes.cleanup(cutoff);
    };

    const isPeakbaggerSender = sender => {
        try {
            return !!(sender && sender.tab && sender.url && /(^|\.)peakbagger\.com$/i.test(new URL(sender.url).hostname));
        } catch { return false; }
    };

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

    const terrainPrefetch = createTerrainPrefetch({
        isPeakbaggerSender,
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
        enqueueGithubWrite,
    });

    const openDraftsManager = async sender => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return { ok: false, reason: 'forbidden' };
        }
        const tab = await ext.tabs.create({
            url: `${ext.runtime.getURL('options/options.html')}#drafts`
        });
        return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null };
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
            const githubHandler = githubRoutes.handlers[type];
            if (githubHandler) return githubHandler(message, sender);
            switch (type) {
            case 'OPEN_DRAFTS_MANAGER': return openDraftsManager(sender);
            case 'CAPTURE_START': return startCapture(message);
            case 'CAPTURE_STATUS': {
                const jobs = await readMap(JOBS_KEY);
                const job = jobs[Number(message.tabId)] || null;
                // Local-file GPX jobs belong to the ascent form, not the popup.
                return job && job.provider !== 'upload' ? publicJob(job) : null;
            }
            case 'GPX_PROCESS_START': return startGpxProcess(message, sender);
            case 'GPX_PROCESS_APPLY': return applyGpxProcess(message, sender);
            case 'CAPTURE_CANCEL': return cancelCapture(message);
            case 'CAPTURE_CLEAR': return clearCapture(message);
            case 'CAPTURE_SELECTION': return publicJob(await updateSelection(message));
            case 'CAPTURE_OPEN_DRAFTS': return openDrafts(message);
            case 'DRAFT_READY': return draftReady(message, sender);
            case 'DRAFT_PREVIEW_STARTED': return previewStarted(message, sender);
            case 'DRAFT_DAY_STATS_APPLIED': return dayStatsApplied(message, sender);
            case 'TERRAIN_PREFETCH': return terrainPrefetch.handle(message, sender);
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
        terrainPrefetch.forgetTab(tabId);
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

    // Register synchronously: a storage event can be the event that wakes the
    // MV3 worker. Only the favorites value is watched, so backup-state writes
    // cannot trigger themselves.
    ext.storage.onChanged.addListener(githubRoutes.onStorageChanged);

    // The alarm is replaced on each change, producing a durable trailing-edge
    // debounce. Nudging favorites here makes enabling its toggle create the
    // first backup; equal signatures make other settings changes free.
    Settings.subscribe(githubRoutes.onSettingsChanged);

    if (ext.alarms) {
        ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
        ext.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === CLEANUP_ALARM) void cleanup();
            githubRoutes.onAlarm(alarm.name);
        });
    }
})();
