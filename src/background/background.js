// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Garmin/Strava capture coordinator. Long-lived state contains only the reduced
// privacy upload and derived ascent values, and lives in storage.session.

// The worker ships as one bundle; capture-core and settings (and their own
// transitive deps: gpx-metrics, settings-schema) resolve through these imports.
import { captureCore as Core } from '../capture/capture-core.js';
import { providerFromUrl, providerActivityUrl } from '../capture/provider-url.js';
import { terrainTiles as TerrainTiles } from '../terrain/terrain-tiles.js';
import { terrainCache as TerrainCache } from '../terrain/terrain-cache.js';
import { settings as Settings } from '../settings/settings.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
import { favoriteClimbers as Favorites } from '../favorites/favorite-climbers.js';
import { githubAuth as GithubAuth } from '../github/github-auth.js';
import { githubClient as GithubClient } from '../github/github-client.js';
import { githubErrors as GithubErrors } from '../github/github-errors.js';
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
    const GITHUB_AUTH_PENDING_KEY = 'bpbGithubAuthPending';
    const FAVORITE_CLIMBERS_BACKUP_PATH = 'favorite-climbers.json';
    const SETTINGS_BACKUP_ALARM = 'bpb-settings-backup';
    const SETTINGS_BACKUP_STATE_KEY = 'bpbSettingsBackupState';
    const FAVORITES_BACKUP_ALARM = 'bpb-favorites-backup';
    const FAVORITES_BACKUP_STATE_KEY = 'bpbFavoritesBackupState';
    const AUTO_BACKUP_DELAY_MINUTES = 1;
    const AUTO_BACKUP_RETRY_MINUTES = 10;
    const AUTO_BACKUP_MAX_RETRIES = 2;
    const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
    const SNAPSHOT_LIMIT = 10;
    const PROFILE_BACKUP_BATCH_LIMIT = 10;
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

    const cancelCapture = async message => {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) throw new Error('Activity tab identity is unavailable.');
        const terminalPhases = new Set(['ready', 'no-matches', 'no-gps', 'error', 'opened', 'previewed']);
        let cancelled = false;
        let current = null;
        await mutateMap(JOBS_KEY, jobs => {
            current = jobs[tabId] || null;
            if (!current || terminalPhases.has(current.phase)) return;
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

    const openDrafts = async message => {
        const tabId = Number(message.tabId);
        await updateSelection(message);
        const jobs = await readMap(JOBS_KEY);
        const job = jobs[tabId];
        if (!isFresh(job) || !job.uploadGpx || (job.phase !== 'ready' && job.phase !== 'opened')) {
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
            .filter(draft => isFresh(draft) && draft.jobId === job.id)
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

        const selectedMatches = Core.assignDraftSuffixes(selectedIds.map(id => byId.get(id)));
        const trackOrdered = selectedMatches.map((match, index) => ({ match, index }))
            .sort((left, right) => {
                const distance = left.match.draftFields.upDistanceM - right.match.draftFields.upDistanceM;
                return Number.isFinite(distance) && distance !== 0 ? distance : left.index - right.index;
            })
            .map(({ match }) => match);
        const sequenceById = new Map(trackOrdered.map((match, index) => [String(match.id), index + 1]));
        const fallbackTripName = trackOrdered.map(match => match.name).join(' / ').slice(0, 200);
        const useTripInfo = job.capturePreferences?.fillTripInfo && selectedMatches.length > 1;
        const useWildernessNights = job.capturePreferences?.fillWildernessNights
            && Number.isInteger(job.nightsOut) && job.nightsOut > 0;
        const primaryMatch = primaryId ? selectedMatches.find(match => String(match.id) === primaryId) : null;
        const siblings = selectedMatches.filter(match => match !== primaryMatch)
            .sort((a, b) => b.confidence - a.confidence);

        const makeDraft = (match, draftTabId, previewOrder, focusOnReady) => ({
            tabId: draftTabId,
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
            previewOrder,
            previewStarted: false,
            complete: false,
            dayStatsPending: false,
            focusOnReady,
            preserveExistingFields: draftTabId === tabId,
            expiresAt: now() + JOB_TTL_MS
        });

        // Every draft is registered before any tab changes URL, so a fast
        // page load can never race its own identity checks.
        let order = 0;
        if (primaryMatch) {
            const currentDraft = makeDraft(primaryMatch, tabId, order++, false);
            await mutateMap(DRAFTS_KEY, drafts => { drafts[tabId] = currentDraft; });
        }
        const sourceTab = await ext.tabs.get(tabId);
        const created = [];
        for (const match of siblings) {
            const tab = await ext.tabs.create({ url: 'about:blank', active: false, windowId: sourceTab.windowId });
            const draft = makeDraft(match, tab.id, order++, !primaryMatch && created.length === 0);
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
        const tabIds = [...(primaryMatch ? [tabId] : []), ...created.map(draft => draft.tabId)];
        await updateJob(tabId, { phase: 'opened', openedDraftTabIds: tabIds, groupWarning });
        await Promise.all(created.map(draft => ext.tabs.update(draft.tabId, {
            url: `https://peakbagger.com/climber/ascentedit.aspx?pid=${draft.pid}&cid=${draft.cid}`,
            active: false
        })));
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

    const peakbaggerMyAscents = async () => {
        let cid;
        try {
            cid = await peakbaggerLogin();
        } catch (error) {
            return {
                ok: false,
                error: {
                    source: error && error.source,
                    code: error && error.code ? error.code : 'peakbagger-unavailable',
                    message: error && error.message
                        ? error.message
                        : 'Could not reach Peakbagger. Check your connection, then try again.',
                },
            };
        }
        if (!cid) {
            return {
                ok: false,
                error: {
                    code: 'peakbagger-signed-out',
                    message: 'Peakbagger could not find a signed-in account. Sign in to Peakbagger, then try again.',
                },
            };
        }
        const url = new URL('https://www.peakbagger.com/climber/ClimbListC.aspx');
        url.searchParams.set('cid', cid);
        url.searchParams.set('j', '-1');
        url.searchParams.set('y', '9999');
        url.searchParams.set('sort', 'AscentDate');
        return { ok: true, url: url.toString() };
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

    // Keep an existing choice only while it remains in the app installation.
    // New connections always go through repository inspection; auto-selecting a
    // sole repo would skip the populated-repository confirmation and collision
    // checks that make this write boundary safe.
    const reconcileDiscoveredRepo = async repos => {
        const selected = await GithubAuth.authStore.getRepo();
        if (!selected) return;
        const stillGranted = repos.some(repo => repo.owner === selected.owner && repo.name === selected.name);
        if (stillGranted) return;
        await GithubAuth.authStore.setRepo(null);
        await GithubAuth.authStore.setInstallationId(null);
    };

    const githubBeginAuth = async () => {
        await clearPendingGithubAuth();
        const flow = GithubAuth.createDeviceFlow({ fetch: netFetch });
        let code;
        try {
            code = await flow.requestCode();
        } catch (error) {
            return { phase: 'error', ...GithubErrors.publicError(error) };
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
            await GithubAuth.authStore.setRepo(null);
            await GithubAuth.authStore.setInstallationId(null);
            let account = null;
            try { account = await GithubAuth.fetchAccount({ fetch: netFetch, token: cred.token }); await GithubAuth.authStore.setAccount(account); } catch { /* non-fatal */ }
            let repos = [];
            let installationCount = 0;
            try {
                const discovered = await GithubAuth.listBackupRepositories({ fetch: netFetch, token: cred.token });
                repos = discovered.repos;
                installationCount = discovered.installationCount;
                await reconcileDiscoveredRepo(repos);
            } catch { /* the user may not have installed yet; discover again later */ }
            await clearPendingGithubAuth();
            return { phase: 'authorized', account, repos, installationCount };
        } catch (error) {
            await clearPendingGithubAuth();
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    // Re-list repositories on demand — after the user returns from the install
    // page having granted (or changed) the selected repositories.
    const githubDiscoverRepos = async () => {
        const token = await GithubAuth.authStore.getToken();
        if (!token) return { phase: 'error', code: 'no-token' };
        try {
            const { repos, installationCount } = await GithubAuth.listBackupRepositories({ fetch: netFetch, token });
            await reconcileDiscoveredRepo(repos);
            return { installationCount, repos, repo: await GithubAuth.authStore.getRepo() };
        } catch (error) {
            return { phase: 'error', ...GithubErrors.publicError(error) };
        }
    };

    const githubSelectRepo = async message => {
        const r = message && message.repo;
        if (!r || !r.owner || !r.name) return { error: 'invalid-repo' };
        const token = await GithubAuth.authStore.getToken();
        if (!token) return { connected: false, error: { code: 'no-token' } };
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token,
            owner: r.owner,
            repo: r.name,
            branch: r.branch || r.defaultBranch || undefined,
        });
        let inspection;
        try {
            inspection = await client.inspectRepository();
        } catch (error) {
            return {
                connected: false,
                error: GithubErrors.publicError(error, 'Could not inspect the repository.'),
            };
        }
        if (inspection.kind === 'existing' && !message.confirmExisting) {
            return {
                connected: false,
                needsConfirmation: true,
                repo: r,
                inspection,
            };
        }
        await GithubAuth.authStore.setRepo({
            owner: r.owner,
            name: r.name,
            branch: inspection.branch,
            id: r.id ?? null,
            fullName: r.fullName || `${r.owner}/${r.name}`,
        });
        if (r.installationId != null) await GithubAuth.authStore.setInstallationId(r.installationId);
        return { ...(await githubStatus()), inspection };
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

    const isClimbListSender = sender => {
        if (!isPeakbaggerSender(sender)) return false;
        try { return /\/climber\/climblistc\.aspx$/i.test(new URL(sender.url).pathname); }
        catch { return false; }
    };

    const openDraftsManager = async sender => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return { ok: false, reason: 'forbidden' };
        }
        const tab = await ext.tabs.create({
            url: `${ext.runtime.getURL('options/options.html')}#drafts`
        });
        return { ok: true, tabId: Number.isInteger(tab?.id) ? tab.id : null };
    };

    // DEM prefetch: warm the extension-origin tile cache from the background
    // worker so opening 3D paints from cache instead of the network. CacheStorage
    // is origin-keyed, so only extension contexts share bpb-mapterhorn-dem-v1 —
    // the peakbagger content script cannot populate it, only ask the worker to.
    const PREFETCH_RATE_MS = 15 * 1000;
    const PREFETCH_TILE_CAP = 32;
    const PREFETCH_CONCURRENCY = 4;
    const PREFETCH_DEDUPE_TTL_MS = 10 * 60 * 1000;
    const prefetchLastByTab = new Map();
    const prefetchRecentTiles = new Map();
    let prefetchCache = null;

    const validPrefetchViewport = viewport => !!viewport
        && Number.isFinite(viewport.width) && viewport.width >= 100 && viewport.width <= 8192
        && Number.isFinite(viewport.height) && viewport.height >= 100 && viewport.height <= 8192;

    const prefetchTilesFor = (message, viewport) => {
        const bounds = message && message.bounds;
        if (bounds && typeof bounds === 'object'
            && [bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].every(Number.isFinite)) {
            return TerrainTiles.tilesForView({
                bounds: {
                    minLat: bounds.minLat, minLon: bounds.minLon,
                    maxLat: bounds.maxLat, maxLon: bounds.maxLon
                },
                viewport, cap: PREFETCH_TILE_CAP
            });
        }
        if (Array.isArray(message.center) && message.center.length === 2
            && message.center.every(Number.isFinite) && Number.isFinite(message.zoom)) {
            return TerrainTiles.tilesForView({
                center: [message.center[0], message.center[1]], zoom: message.zoom,
                viewport, cap: PREFETCH_TILE_CAP
            });
        }
        return null;
    };

    const terrainPrefetch = async (message, sender) => {
        // A Peakbagger content script asking to warm the cache for a view it is
        // about to render; nothing else may drive worker→Mapterhorn traffic.
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) return { ok: false, reason: 'forbidden' };
        const settings = await Settings.get();
        // 3D enablement is the consent gate for contacting Mapterhorn; a zero
        // cache budget means there is nothing to warm.
        if (settings.enable3dMap !== true || !(settings.terrainCacheLimitMb > 0)) return { ok: false, reason: 'disabled' };
        if (!validPrefetchViewport(message && message.viewport)) return { ok: false, reason: 'invalid' };

        const tiles = prefetchTilesFor(message, message.viewport);
        if (tiles === null) return { ok: false, reason: 'invalid' };
        if (!tiles.length) return { ok: true, tiles: 0 };

        // One accepted prefetch per tab per 15 s. Charged only once a request is
        // well-formed enough to do work, so a malformed burst cannot lock a tab.
        const tabId = sender.tab.id;
        const nowMs = now();
        const last = prefetchLastByTab.get(tabId);
        if (Number.isFinite(last) && nowMs - last < PREFETCH_RATE_MS) return { ok: false, reason: 'throttled' };
        prefetchLastByTab.set(tabId, nowMs);

        const limitMb = settings.terrainCacheLimitMb;
        if (!prefetchCache || prefetchCache.limitMb !== limitMb) {
            prefetchCache = { limitMb, cache: TerrainCache.create({ limitMb }) };
        }
        const cache = prefetchCache.cache;

        // Skip tiles a recent burst already fetched or is fetching; expire the
        // record so a later view of the same area re-warms if it was evicted.
        for (const [key, expiry] of prefetchRecentTiles) {
            if (expiry <= nowMs) prefetchRecentTiles.delete(key);
        }
        const fresh = [];
        for (const tile of tiles) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            if (prefetchRecentTiles.has(key)) continue;
            prefetchRecentTiles.set(key, nowMs + PREFETCH_DEDUPE_TTL_MS);
            fresh.push({ tile, key });
        }

        let loaded = 0;
        const queue = fresh.slice();
        const worker = async () => {
            while (queue.length) {
                const { tile, key } = queue.shift();
                try {
                    await cache.load({ url: `bpb-dem://${tile.z}/${tile.x}/${tile.y}.webp` });
                    loaded++;
                } catch (error) {
                    // A failed tile is not warmed; drop its record so a later
                    // prefetch retries instead of skipping it as "recently done".
                    prefetchRecentTiles.delete(key);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, worker));
        return { ok: true, tiles: loaded };
    };

    // The save-time snapshot from the ascentedit content script: keep it in
    // storage.session, keyed by identity and source tab, for the saved ascent
    // page to back up. The tab namespace prevents two simultaneous new-ascent
    // forms for the same climber/peak/date from overwriting one another before
    // Peakbagger has assigned either ascent an id.
    // Accepted only from a Peakbagger tab and only while the feature is enabled;
    // the cleanup alarm expires it on the 30-minute horizon.
    const storeBackupSnapshot = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, reason: 'forbidden' };
        if (!message || !message.key || !message.snapshot) return { ok: false, reason: 'invalid' };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, reason: 'disabled' };
        const sourceTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        const storageKey = sourceTabId == null ? message.key : `${message.key}|tab:${sourceTabId}`;
        await mutateMap(SNAPSHOTS_KEY, snapshots => {
            snapshots[storageKey] = {
                identity: message.identity || null,
                snapshot: message.snapshot,
                sourceTabId,
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

    // Profile backup preflight adds the repository's ascent-folder leaves to
    // the ordinary status. This stays a dedicated message so viewing a saved
    // ascent never pays for GitHub tree reads.
    const githubProfileBackupStatus = async sender => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const status = await githubBackupStatus(sender);
        if (!status.enabled || !status.connected) return { ok: true, ...status, folders: [] };
        const auth = await GithubAuth.authStore.read();
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token: auth.token,
            owner: auth.repo.owner,
            repo: auth.repo.name,
            branch: auth.repo.branch || undefined,
        });
        try {
            return { ok: true, ...status, folders: await client.getAscentFolders() };
        } catch (error) {
            return { ok: false, ...status, error: GithubErrors.publicError(error, 'Could not read the backup repository.') };
        }
    };

    // Merge the pending save-time snapshot with the saved ascent page's fields.
    // The saved page is authoritative for the identity and the fields it renders
    // (aid, date, suffix, peak name/elevation/location); the snapshot supplies
    // the fields the page does not (the entered numbers) and the resolved report.
    const mergeBackupSnapshot = (snap, page = {}, { pageComplete = false } = {}) => {
        const p = page && typeof page === 'object' ? page : {};
        const base = snap && typeof snap === 'object' ? snap : null;
        if (!base && !p.ascent && !p.peak) return null;
        const ascent = { ...(base ? base.ascent : {}) };
        const pAscent = p.ascent || {};
        if (pageComplete) {
            // A parsed edit form is the complete persisted record. Copy explicit
            // blanks too so a field the user cleared does not survive from the
            // pending save-time snapshot.
            for (const [key, value] of Object.entries(pAscent)) {
                if (value !== undefined) ascent[key] = value;
            }
        } else {
            if (pAscent.id != null) ascent.id = pAscent.id;
            if (pAscent.date) ascent.date = pAscent.date;
            if (typeof pAscent.suffix === 'string' && pAscent.suffix) ascent.suffix = pAscent.suffix;
        }
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
    // by peak+date. A peak-only match can attach a different ascent's report and
    // fields, so absence of a precise match is handled by the complete edit-form
    // snapshot supplied by the individual backup surface.
    const findSnapshotForPage = async (page, sender) => {
        const snapshots = await readMap(SNAPSHOTS_KEY);
        const entries = Object.entries(snapshots)
            .filter(([, record]) => isFresh(record))
            .map(([key, record]) => ({ key, record }))
            .sort((a, b) => (b.record.savedAt || 0) - (a.record.savedAt || 0));
        const idOf = e => e.record.identity || {};
        const ascentId = page && page.ascent ? page.ascent.id : null;
        const peakId = page && page.peak ? page.peak.id : null;
        const date = page && page.ascent ? page.ascent.date : null;
        const sourceTabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
        const find = predicate => (sourceTabId == null ? null : entries.find(e => e.record.sourceTabId === sourceTabId && predicate(e)))
            || entries.find(predicate);
        let match = ascentId != null ? find(e => idOf(e).ascentId === ascentId) : null;
        if (!match && peakId != null && date) match = find(e => idOf(e).peakId === peakId && idOf(e).date === date);
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

        const found = await findSnapshotForPage(message.page, sender);
        // Automatic backup fires on every saved-ascent page load, so it must push
        // only right after a save — i.e. when a matching pending snapshot exists.
        // Without one (an old ascent merely being viewed) it declines quietly so
        // it never re-pushes on a revisit; the manual button is still offered.
        if (message.auto && !found) return { ok: false, error: { code: 'no-fresh-save' } };
        // Without a pending save snapshot, only a complete owner edit-form read
        // is safe to commit. A sparse display-page payload would erase fields an
        // existing backup already holds.
        if (!found && !message.pageComplete) return { ok: false, error: { code: 'no-data' } };
        const snapshot = mergeBackupSnapshot(found && found.record.snapshot, message.page, {
            pageComplete: !!message.pageComplete,
        });
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
            const result = await enqueueGithubWrite(() => client.pushAscentBackup(snapshot, { gpx: message.gpx }));
            // The snapshot has served its purpose; drop it so a later view of the
            // same page does not re-push from stale data.
            if (found) await mutateMap(SNAPSHOTS_KEY, m => { delete m[found.key]; });
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The backup failed.') };
        }
    };

    // Passive, read-only comparison for an owner ascent page. It accepts only
    // the same complete edit-form snapshot that a manual backup would write,
    // so an incomplete page can never be labelled current from a sparse view.
    const checkAscentBackup = async (message, sender) => {
        if (!isPeakbaggerSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, error: { code: 'disabled' } };
        const auth = await GithubAuth.authStore.read();
        if (!auth || !auth.token) return { ok: false, error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) return { ok: false, error: { code: 'no-repo' } };
        if (!message || !message.pageComplete) return { ok: false, error: { code: 'no-data' } };
        const snapshot = mergeBackupSnapshot(null, message.page, { pageComplete: true });
        if (!snapshot || snapshot.ascent.id == null) return { ok: false, error: { code: 'no-data' } };
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token: auth.token,
            owner: auth.repo.owner,
            repo: auth.repo.name,
            branch: auth.repo.branch || undefined,
        });
        try {
            return {
                ok: true,
                current: await client.isAscentBackupCurrent(snapshot, { gpx: message.gpx }),
            };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'Could not check the existing backup.') };
        }
    };

    // A profile batch is one ordered branch mutation containing up to ten
    // independently identity-checked ascents. The content script never sees
    // the token, and a malformed entry rejects the entire batch before GitHub
    // receives anything.
    const backupProfileBatch = async (message, sender) => {
        if (!isClimbListSender(sender)) return { ok: false, error: { code: 'forbidden' } };
        const entries = message && message.entries;
        if (!Array.isArray(entries) || entries.length === 0 || entries.length > PROFILE_BACKUP_BATCH_LIMIT) {
            return { ok: false, error: { code: 'no-data' } };
        }
        const seen = new Set();
        for (const entry of entries) {
            const ascentId = entry && entry.snapshot && entry.snapshot.ascent
                ? Number(entry.snapshot.ascent.id)
                : NaN;
            if (!Number.isFinite(ascentId) || ascentId <= 0 || ascentId !== Number(entry.aid) || seen.has(ascentId)) {
                return { ok: false, error: { code: 'no-data' } };
            }
            seen.add(ascentId);
        }
        const settings = await Settings.get();
        if (!settings.enableGithubBackup) return { ok: false, error: { code: 'disabled' } };
        const auth = await GithubAuth.authStore.read();
        if (!auth || !auth.token) return { ok: false, error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) return { ok: false, error: { code: 'no-repo' } };

        const version = ext.runtime.getManifest ? ext.runtime.getManifest().version : '';
        for (const entry of entries) {
            entry.snapshot.backup = {
                ...(entry.snapshot.backup || {}),
                syncedAt: new Date().toISOString(),
                extensionVersion: version,
            };
        }
        const client = GithubClient.createGithubClient({
            fetch: netFetch,
            token: auth.token,
            owner: auth.repo.owner,
            repo: auth.repo.name,
            branch: auth.repo.branch || undefined,
        });
        try {
            const result = await enqueueGithubWrite(() => client.pushAscentBackups(entries.map(entry => ({
                snapshot: entry.snapshot,
                gpx: entry.gpx,
            }))));
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The backup failed.') };
        }
    };

    const optionsGithubClient = async () => {
        const auth = await GithubAuth.authStore.read();
        if (!auth || !auth.token) return { error: { code: 'not-connected' } };
        if (!auth.repo || !auth.repo.owner || !auth.repo.name) return { error: { code: 'no-repo' } };
        return {
            client: GithubClient.createGithubClient({
                fetch: netFetch,
                token: auth.token,
                owner: auth.repo.owner,
                repo: auth.repo.name,
                branch: auth.repo.branch || undefined,
            }),
        };
    };

    // Debounced, signature-gated automatic backup shared by the settings and
    // favorites paths. Replacing a named alarm gives us trailing-edge debounce
    // that survives MV3 worker teardown; fire() rechecks every gate so stale or
    // spurious alarms are harmless.
    const createAutoBackup = ({ alarmName, stateKey, path, commitMessage, enabled, build }) => {
        const readState = async () => (await ext.storage.local.get(stateKey))[stateKey] || null;
        const markSynced = signature => ext.storage.local.set({
            [stateKey]: { signature, syncedAt: new Date().toISOString() }
        });

        const schedule = () => {
            if (!ext.alarms) return;
            ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_DELAY_MINUTES });
            // A fresh change grants a fresh retry budget.
            void readState().then(state => {
                if (state && state.attempts) {
                    return ext.storage.local.set({ [stateKey]: { ...state, attempts: 0 } });
                }
                return undefined;
            });
        };

        const fire = async () => {
            if (!(await enabled())) return;
            const access = await optionsGithubClient();
            if (access.error) return;
            const { text, signature } = await build();
            const state = await readState();
            if (state && state.signature === signature) return;
            try {
                await enqueueGithubWrite(() => access.client.putRootFile(path, text, commitMessage));
                await markSynced(signature);
            } catch {
                // Silent bounded retry; the manual buttons remain the loud path.
                const attempts = ((state && state.attempts) || 0) + 1;
                await ext.storage.local.set({ [stateKey]: { ...(state || {}), attempts } });
                if (attempts <= AUTO_BACKUP_MAX_RETRIES) {
                    ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_RETRY_MINUTES });
                }
            }
        };

        return { schedule, fire, markSynced };
    };

    const buildSettingsBackup = async () => {
        const settings = await Settings.get();
        const payload = Transfer.buildPayload(settings, {
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
            exportedAt: new Date().toISOString()
        });
        return { text: Transfer.serialize(payload), signature: Transfer.signature(settings) };
    };

    const settingsAutoBackup = createAutoBackup({
        alarmName: SETTINGS_BACKUP_ALARM,
        stateKey: SETTINGS_BACKUP_STATE_KEY,
        path: Transfer.BACKUP_PATH,
        commitMessage: 'Back up settings',
        enabled: async () => (await Settings.get()).autoSettingsBackup,
        build: buildSettingsBackup
    });

    const buildFavoritesBackup = async () => {
        const stored = await ext.storage.local.get(Favorites.FAVORITES_KEY);
        const favorites = Favorites.cleanFavorites(stored[Favorites.FAVORITES_KEY]);
        const payload = Favorites.buildBackupPayload(favorites, { exportedAt: new Date().toISOString() });
        return {
            text: Favorites.serializeBackup(payload),
            signature: Favorites.backupSignature(favorites)
        };
    };

    const favoritesAutoBackup = createAutoBackup({
        alarmName: FAVORITES_BACKUP_ALARM,
        stateKey: FAVORITES_BACKUP_STATE_KEY,
        path: FAVORITE_CLIMBERS_BACKUP_PATH,
        commitMessage: 'Back up favorite climbers',
        enabled: async () => (await Settings.get()).autoFavoritesBackup,
        build: buildFavoritesBackup
    });

    const backupSettings = async () => {
        const access = await optionsGithubClient();
        if (access.error) return { ok: false, error: access.error };
        const { text, signature } = await buildSettingsBackup();
        try {
            const result = await enqueueGithubWrite(() => access.client.putRootFile(
                Transfer.BACKUP_PATH, text, 'Back up settings'
            ));
            await settingsAutoBackup.markSynced(signature);
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The settings backup failed.') };
        }
    };

    const restoreSettings = async () => {
        const access = await optionsGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            return { ok: true, content: await access.client.readRootFile(Transfer.BACKUP_PATH) };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The settings backup could not be read.') };
        }
    };

    // The worker owns serialization for both manual and automatic backups; the
    // options page still owns restore validation and reversible replacement.
    const backupFavorites = async () => {
        const access = await optionsGithubClient();
        if (access.error) return { ok: false, error: access.error };
        const { text, signature } = await buildFavoritesBackup();
        try {
            const result = await enqueueGithubWrite(() => access.client.putRootFile(
                FAVORITE_CLIMBERS_BACKUP_PATH, text, 'Back up favorite climbers'
            ));
            await favoritesAutoBackup.markSynced(signature);
            return { ok: true, result };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The favorites backup failed.') };
        }
    };

    const restoreFavorites = async () => {
        const access = await optionsGithubClient();
        if (access.error) return { ok: false, error: access.error };
        try {
            return { ok: true, content: await access.client.readRootFile(FAVORITE_CLIMBERS_BACKUP_PATH) };
        } catch (error) {
            return { ok: false, error: GithubErrors.publicError(error, 'The favorites backup could not be read.') };
        }
    };

    ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const run = async () => {
            const type = message?.type;
            // Account setup and navigation helpers are extension-page only;
            // neither the GitHub token nor the signed-in climber identity
            // crosses to a content script.
            const extensionOnly = type === 'PEAKBAGGER_MY_ASCENTS'
                || type === 'GITHUB_FAVORITES_BACKUP'
                || type === 'GITHUB_FAVORITES_RESTORE'
                || type === 'GITHUB_SETTINGS_BACKUP'
                || type === 'GITHUB_SETTINGS_RESTORE'
                || (typeof type === 'string' && type.startsWith('GITHUB_AUTH_'));
            if (extensionOnly && !isExtensionPage(sender)) {
                return { error: 'forbidden' };
            }
            switch (type) {
            case 'PEAKBAGGER_MY_ASCENTS': return peakbaggerMyAscents();
            case 'GITHUB_AUTH_STATUS': return githubStatus();
            case 'GITHUB_AUTH_BEGIN': return githubBeginAuth();
            case 'GITHUB_AUTH_STATE': return githubPollAuth();
            case 'GITHUB_AUTH_DISCOVER': return githubDiscoverRepos();
            case 'GITHUB_AUTH_SELECT_REPO': return githubSelectRepo(message);
            case 'GITHUB_AUTH_DISCONNECT': return githubDisconnect();
            case 'GITHUB_BACKUP_SNAPSHOT': return storeBackupSnapshot(message, sender);
            case 'GITHUB_BACKUP_STATUS': return githubBackupStatus(sender);
            case 'GITHUB_CHECK_ASCENT_BACKUP': return checkAscentBackup(message, sender);
            case 'GITHUB_BACKUP_ASCENT': return backupAscent(message, sender);
            case 'GITHUB_BACKUP_PROFILE_STATUS': return githubProfileBackupStatus(sender);
            case 'GITHUB_BACKUP_PROFILE_BATCH': return backupProfileBatch(message, sender);
            case 'GITHUB_FAVORITES_BACKUP': return backupFavorites();
            case 'GITHUB_FAVORITES_RESTORE': return restoreFavorites();
            case 'GITHUB_SETTINGS_BACKUP': return backupSettings();
            case 'GITHUB_SETTINGS_RESTORE': return restoreSettings();
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
            case 'TERRAIN_PREFETCH': return terrainPrefetch(message, sender);
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
        prefetchLastByTab.delete(tabId);
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
    ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[Favorites.FAVORITES_KEY]) return;
        void Settings.get().then(settings => {
            if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
        });
    });

    // The alarm is replaced on each change, producing a durable trailing-edge
    // debounce. Nudging favorites here makes enabling its toggle create the
    // first backup; equal signatures make other settings changes free.
    Settings.subscribe(settings => {
        if (settings.autoSettingsBackup) settingsAutoBackup.schedule();
        if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
    });

    if (ext.alarms) {
        ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
        ext.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === CLEANUP_ALARM) void cleanup();
            if (alarm.name === SETTINGS_BACKUP_ALARM) void settingsAutoBackup.fire();
            if (alarm.name === FAVORITES_BACKUP_ALARM) void favoritesAutoBackup.fire();
        });
    }
})();
