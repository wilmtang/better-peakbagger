// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createGarminStore, garminPublicSummary } from './garmin-store.js';
import { createGarminClient, GarminError, GARMIN_PERMISSION, positiveId } from './garmin-api.js';
import { decodeGarminRecording } from './fit-activity.js';
import { createPackagedPageMatcher } from '../background/sender-policy.js';
import { settingsSchema as Schema } from '../settings/settings-schema.js';

export const GARMIN_ALARM = 'bpb-garmin-check';
// The stored "walking" preference remains compatible with existing installations.
const MOUNTAIN_ACTIVITY_TYPES = ['hiking', 'walking', 'trail_running', 'mountaineering', 'rock_climbing', 'backcountry_skiing_snowboarding'];
const DAY = 86400000;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const validImportDate = Schema.validCalendarDate;
export function importRange(settings, connectionDate, lastCheck, full, date = today()) {
    const start = settings.garminHistoryStart || connectionDate;
    const scope = start === 'all' ? '1970-01-01' : start;
    const lookback = new Date(Date.parse(`${date}T00:00:00Z`) - (settings.garminRecentDays - 1) * DAY).toISOString().slice(0, 10);
    const catchup = lastCheck ? new Date(lastCheck - DAY).toISOString().slice(0, 10) : lookback;
    return { from: full ? scope : [scope, [lookback, catchup].sort()[0]].sort().at(-1), to: date };
}
export function createGarminImports({ ext, settings, store = createGarminStore(), clientFactory = createGarminClient,
    decode = decodeGarminRecording, prepare, binding, openDrafts, clock = Date.now, date = today } = {}) {
    const trusted = createPackagedPageMatcher(ext, ['options/options.html', 'options/inbox.html']);
    const popup = createPackagedPageMatcher(ext, ['popup/popup.html']);
    let visiting = null; let running = null; let queuedFull = null; let queuedResume = null; let controller = null; let opening = null; let client = null; let clientEpoch = -1; let publicCache = null;
    const mutateEpoch = (epoch, mutate) => store.mutate(state => {
        if (state.epoch !== epoch) throw new GarminError('cancelled'); return mutate(state);
    });
    const api = state => {
        if (clientEpoch !== state.epoch) { client = clientFactory({ key: state.connection.key, signal: controller?.signal }); clientEpoch = state.epoch; }
        return client;
    };
    const permission = () => ext.permissions.contains({ origins: [GARMIN_PERMISSION] });
    const identity = async service => { const result = await service.owner();
        return typeof result === 'string' ? { subject: result, owner: result } : result; };
    const reconcile = async () => {
        await ext.alarms.clear(GARMIN_ALARM);
        const [state, prefs] = await Promise.all([store.read(), settings.requireCurrent()]);
        if (!prefs.enableGarminInbox || !state.connection?.key || !state.connection.enabled || state.error?.code === 'key-rejected' || !await permission()
            || (state.error?.code === 'capacity' && !state.preparePending)) return;
        const continuing = state.scan || (state.preparePending && !state.peakbaggerBlocked);
        if (!continuing && !prefs.garminCheckHours) return;
        const due = continuing ? Math.max(clock() + 60000, state.retryAt || 0) : Math.max(clock() + 60000, state.lastCheck + prefs.garminCheckHours * 3600000, state.retryAt || 0);
        await ext.alarms.create(GARMIN_ALARM, { when: due });
    };
    const settingsChanged = async () => {
        const prefs = await settings.requireCurrent();
        const scope = JSON.stringify([prefs.garminHistoryStart, prefs.garminRecentDays, prefs.garminActivityTypes]);
        const state = await store.read();
        if (state.featureEnabled !== prefs.enableGarminInbox || state.scope !== scope || state.privacy !== JSON.stringify([prefs.removeGpxTimestamps, prefs.retainWaypoints])) {
            controller?.abort(); clientEpoch = -1;
            await store.mutate(current => {
                current.epoch++;
                current.featureEnabled = prefs.enableGarminInbox;
                if (current.scope !== scope) { current.lastFull = 0; current.scan = null; }
                current.scope = scope; current.privacy = JSON.stringify([prefs.removeGpxTimestamps, prefs.retainWaypoints]);
                for (const item of Object.values(current.items)) {
                    if (!item.analysis) continue;
                    if (!prefs.retainWaypoints) item.analysis.waypoints = [];
                    if (prefs.removeGpxTimestamps) for (const segment of item.analysis.route || []) for (const point of segment) point.time = null;
                }
            });
        }
        await reconcile();
    };
    const connect = async key => {
        if (!(await settings.requireCurrent()).enableGarminInbox) throw new GarminError('disabled');
        if (!await permission()) throw new GarminError('permission');
        const previous = await store.read();
        const candidate = clientFactory({ key }); const account = await identity(candidate);
        if (previous.connection && (previous.connection.subject || previous.connection.owner) !== account.subject) throw new GarminError('identity');
        controller?.abort(); clientEpoch = -1; client = null;
        await mutateEpoch(previous.epoch, state => {
            state.epoch++;
            state.credentialEpoch = (state.credentialEpoch || 0) + 1;
            state.connection = { ...state.connection, key, ...account, connectedDate: state.connection?.connectedDate || date(), enabled: state.connection?.enabled === true };
            state.error = null; state.retryAt = 0; state.scan = null;
        });
        await reconcile();
    };
    const disconnect = async (removeData = false) => {
        controller?.abort(); clientEpoch = -1; client = null;
        await store.mutate(state => {
            state.epoch++; if (state.connection) { state.connection.key = null; state.connection.enabled = false; }
            state.credentialEpoch = (state.credentialEpoch || 0) + 1;
            state.scan = null; state.error = null;
            if (removeData) { state.connection = null; state.items = {}; state.receipts = {}; state.lastCheck = 0; state.lastFull = 0; }
        });
        await ext.alarms.clear(GARMIN_ALARM); await ext.permissions.remove({ origins: [GARMIN_PERMISSION] });
    };
    const pruneDismissed = state => {
        for (const [id, item] of Object.entries(state.items)) {
            if (item.phase === 'dismissed' && item.undoUntil <= clock()) delete state.items[id];
        }
        if (state.error?.code === 'capacity' && Object.keys(state.items).length < 200) state.error = null;
    };
    const snapshot = async (includeItems = true) => {
        const [initialMeta, prefs] = await Promise.all([store.summary(), settings.requireCurrent()]);
        if (!prefs.enableGarminInbox) return { featureEnabled: false, enabled: false, configured: false, pending: 0, queued: 0, items: [], history: [] };
        let meta = initialMeta;
        if (meta.undoDue <= clock()) {
            await store.mutate(pruneDismissed);
            await reconcile();
            meta = await store.summary();
        }
        if (includeItems && publicCache?.revision !== meta.revision) {
            const state = await store.read(); meta = garminPublicSummary(state);
            publicCache = { revision: meta.revision, items: Object.values(state.items).filter(item => item.phase !== 'dismissed').map(item => ({
                id: item.id, phase: item.phase, saved: item.saved || [], error: item.error, handoff: !!item.handoff,
                summary: { type: item.summary?.type || 'activity', date: item.summary?.date || '' },
                analysis: item.analysis ? { matches: item.analysis.matches.map(match => ({ id: match.id, name: match.name,
                    classification: match.classification, confidence: match.confidence, evidence: match.evidence })),
                hasTimestamps: item.analysis.route?.some(segment => segment.some(point => point.time !== null)) } : null,
            })), history: Object.entries(state.receipts).slice(-200).map(([id, receipt]) => ({ id, complete: !!receipt.complete,
                dismissed: !!receipt.dismissed, date: receipt.date || '', undoUntil: state.items[id]?.undoUntil || 0 })) };
        }
        return { ...meta, featureEnabled: true, connectedDate: meta.connectedDate || date(), checking: !!running,
            nextCheck: prefs.garminCheckHours ? Math.max(meta.retryAt || 0, meta.lastCheck + prefs.garminCheckHours * 3600000) : null,
            manual: prefs.garminCheckHours === 0, ...(includeItems ? { items: publicCache.items, history: publicCache.history.map(item => ({ ...item, undoAvailable: item.undoUntil > clock() })) } : {}) };
    };
    const runCheck = async (full, continuation = false, { prepareOnly = false, resume = false, tabId = null } = {}) => {
        controller = new AbortController(); clientEpoch = -1;
        let state = await store.read();
        if (Object.values(state.items).some(item => item.phase === 'dismissed' && item.undoUntil <= clock())) {
            await store.mutate(pruneDismissed); state = await store.read();
        }
        const connection = state.connection;
        const prefs = await settings.requireCurrent();
        if (!prefs.enableGarminInbox || !connection?.key || !connection.enabled) return;
        if (!await permission()) throw new GarminError('permission');
        if (state.error?.code === 'key-rejected') throw new GarminError('key-rejected');
        if (state.retryAt > clock()) throw new GarminError('rate', state.retryAt);
        const epoch = state.epoch, service = api(state);
        const account = await identity(service);
        if (account.subject !== (connection.subject || connection.owner) || (connection.owner && account.owner !== connection.owner)) throw new GarminError('identity');
        if (!connection.owner && account.owner) {
            connection.owner = account.owner;
            await mutateEpoch(epoch, current => { current.connection.owner = account.owner; });
        }
        const fullScan = full || !!state.scan?.full || clock() - state.lastFull >= 7 * DAY;
        const scope = JSON.stringify([prefs.garminHistoryStart, prefs.garminRecentDays, prefs.garminActivityTypes]);
        const range = state.scan?.scope === scope && (!full || state.scan.full) ? { from: state.scan.from, to: state.scan.to }
            : importRange(prefs, connection.connectedDate, state.lastCheck, fullScan, date());
        const signature = JSON.stringify({ ...range, types: prefs.garminActivityTypes });
        let scan = state.scan?.signature === signature ? state.scan : { ...range, scope, signature, offset: 0, full: fullScan, head: null };
        const skipDiscovery = prepareOnly || continuation && (state.error?.code === 'capacity' || (!state.scan && (!prefs.garminCheckHours || clock() - state.lastCheck < prefs.garminCheckHours * 3600000)));
        for (let page = 0; page < (skipDiscovery ? 0 : 3); page++) {
            const rows = await service.list({ ...range, start: scan.offset });
            const fingerprint = rows.map(row => row.id).join(',');
            if (scan.offset === 0) scan.head = fingerprint;
            try { await mutateEpoch(epoch, current => {
                for (const row of rows) {
                    if (row.owner && row.owner !== connection.owner) throw new GarminError('identity');
                    if (row.date < range.from || row.date > range.to || (prefs.garminActivityTypes === 'walking' && !MOUNTAIN_ACTIVITY_TYPES.includes(row.type))) continue;
                    if (current.items[row.id] || current.receipts[row.id]) continue;
                    if (Object.keys(current.items).length >= 200) throw new GarminError('capacity');
                    current.items[row.id] = { id: row.id, owner: connection.owner, cid: connection.cid, summary: row, phase: 'waiting', createdAt: clock(), saved: [] };
                }
                current.error = null;
            }); } catch (error) {
                if (error.code !== 'capacity') throw error;
                await mutateEpoch(epoch, current => { current.error = { code: 'capacity', message: error.message }; current.scan = scan; });
                break;
            }
            if (rows.length < 50) {
                // Offset pages can move during upload. Verify the leading page
                // again before claiming complete coverage; IDs deduplicate overlap.
                const head = (await service.list({ ...range, start: 0 })).map(row => row.id).join(',');
                const complete = head === scan.head;
                await mutateEpoch(epoch, current => {
                    current.scan = complete ? null : { ...scan, offset: 0, head: null };
                    if (complete) { current.lastCheck = clock(); if (fullScan) current.lastFull = clock(); }
                });
                break;
            }
            scan = { ...scan, offset: scan.offset + 45 };
            await mutateEpoch(epoch, current => { current.scan = scan; });
        }
        const queuedState = await store.read();
        if (queuedState.peakbaggerBlocked && (!resume || queuedState.peakbaggerBlocked.retryAt > clock())) return;
        const items = Object.values(queuedState.items).filter(item => !item.handoff && ['waiting', 'error'].includes(item.phase) && !(item.retryAt > clock())).slice(0, 3);
        if (!items.length) { await mutateEpoch(epoch, next => { next.preparePending = false; }); return; }
        const pausePeaks = async error => {
            if (controller.signal.aborted) throw error;
            await mutateEpoch(epoch, next => {
                next.peakbaggerBlocked = { code: error.code === 'cloudflare' ? 'cloudflare' : error.code === 'rate-limit' ? 'rate-limit' : 'peakbagger',
                    retryAt: Number.isFinite(error.retryAt) ? error.retryAt : 0 };
                next.preparePending = false;
            });
        };
        for (const item of items) {
            controller.signal.throwIfAborted();
            let context;
            try {
                context = await binding(connection.cid, { tabId, signal: controller.signal });
                await mutateEpoch(epoch, next => { next.peakbaggerBlocked = null; });
            } catch (error) { await pausePeaks(error); return; }
            let stage = 'download';
            try {
                const bytes = await service.recording(item.id, connection.owner);
                stage = 'decode';
                const route = await decode(bytes, { signal: controller.signal, retainWaypoints: prefs.retainWaypoints });
                stage = 'prepare';
                const result = await prepare(item, route, context, controller.signal);
                await mutateEpoch(epoch, current => {
                    if (!current.items[item.id] || current.items[item.id].handoff
                        || current.items[item.id].phase === 'dismissed'
                        || (current.items[item.id].revision || 0) !== (item.revision || 0)) return;
                    const next = { ...current.items[item.id], ...result, phase: result.phase || 'ready', error: null };
                    const size = new TextEncoder().encode(JSON.stringify({ ...current.items, [item.id]: next })).length;
                    if (size > 20 * 1024 * 1024) throw new GarminError('capacity');
                    current.items[item.id] = next;
                });
            } catch (error) {
                if (controller.signal.aborted || ['key-rejected', 'rate', 'identity', 'capacity'].includes(error.code)) throw error;
                if (stage === 'prepare' && (['cloudflare', 'rate-limit', 'network', 'server'].includes(error.code) || error.code?.startsWith('peakbagger-'))) {
                    await pausePeaks(error); return;
                }
                await mutateEpoch(epoch, current => {
                    if (current.items[item.id] && !current.items[item.id].handoff
                        && current.items[item.id].phase !== 'dismissed'
                        && (current.items[item.id].revision || 0) === (item.revision || 0)) Object.assign(current.items[item.id], {
                        phase: stage === 'decode' ? 'unsupported' : 'error',
                        error: stage === 'decode' ? 'This recording is damaged or unsupported. Open Garmin and use its GPX export.'
                            : stage === 'prepare' ? 'Could not finish finding peaks. Open Peakbagger and check again.'
                                : 'This recording could not be downloaded. Check Garmin and try again.',
                        retryAt: clock() + 3600000 });
                });
            }
        }
        await mutateEpoch(epoch, current => { current.preparePending = Object.values(current.items).some(item => item.phase === 'waiting'); });
    };
    const check = (full = false, continuation = false, options = {}) => {
        if (running) {
            if (full) return queuedFull ||= running.then(() => { queuedFull = null; return check(true, false, options); });
            if (options.resume) return queuedResume ||= running.then(() => { queuedResume = null; return check(false, continuation, options); });
            return running;
        }
        running = runCheck(full, continuation, options).catch(async error => {
            if (controller?.signal.aborted) return;
            const failure = error instanceof GarminError ? error : new GarminError('offline');
            await store.mutate(state => { state.error = { code: failure.code, message: failure.message }; state.retryAt = failure.retryAt || 0; });
        }).finally(async () => { running = null; await reconcile(); });
        return running;
    };
    // Visits only prepare durable items; they never widen or rescan Garmin history.
    const peakbaggerVisited = tabId => {
        if (visiting) return visiting;
        visiting = (async () => {
            await running;
            let previous = Infinity;
            for (;;) {
                if (!(await settings.requireCurrent()).enableGarminInbox) return;
                const state = await store.read();
                const count = Object.values(state.items).filter(item => !item.handoff && ['waiting', 'error'].includes(item.phase) && !(item.retryAt > clock())).length;
                if (!state.connection?.key || !state.connection.enabled || !count || count >= previous
                    || state.peakbaggerBlocked?.retryAt > clock() || state.error?.code === 'key-rejected') return;
                previous = count;
                await check(false, false, { prepareOnly: true, resume: true, tabId });
                if ((await store.read()).peakbaggerBlocked) return;
            }
        })().finally(() => { visiting = null; });
        return visiting;
    };
    const openInbox = () => {
        if (opening) return opening;
        opening = (async () => {
            const url = ext.runtime.getURL('options/inbox.html');
            const tabs = await ext.tabs.query({});
            const tab = tabs.find(candidate => { try { const actual = new URL(candidate.url), expected = new URL(url); return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname; } catch { return false; } });
            const opened = tab ? await ext.tabs.update(tab.id, { active: true }) : await ext.tabs.create({ url, active: true });
            if (tab && Number.isInteger(tab.windowId)) await ext.windows.update(tab.windowId, { focused: true });
            return { ok: true, tabId: opened.id };
        })().finally(() => { opening = null; });
        return opening;
    };
    const handlers = {
        GARMIN_STATUS: async () => ({ ok: true, ...await snapshot() }),
        GARMIN_SUMMARY: async () => ({ ok: true, ...await snapshot(false) }),
        GARMIN_INBOX_OPEN: openInbox,
        GARMIN_CONNECT: async message => { await connect(message.key); return { ok: true, ...await snapshot() }; },
        GARMIN_DISCONNECT: async message => { await disconnect(message.deleteData === true); return { ok: true, ...await snapshot() }; },
        GARMIN_ENABLE: async () => {
            const current = await store.read(); if (!current.connection?.key) throw new GarminError('key-rejected');
            if (!await permission()) throw new GarminError('permission');
            const context = await binding(current.connection.cid);
            await mutateEpoch(current.epoch, state => { state.connection.cid = context.cid; state.connection.enabled = true;
                state.error = null;
                state.credentialEpoch = (state.credentialEpoch || 0) + 1; });
            await reconcile(); return { ok: true, ...await snapshot() };
        },
        GARMIN_CHECK: async message => { void check(message.full === true, false, { resume: true }); return { ok: true }; },
        GARMIN_DISMISS: async message => {
            await store.mutate(state => { const item = state.items[message.id]; if (!item) return;
                if (item.handoff) throw new GarminError('handoff');
                item.revision = (item.revision || 0) + 1;
                item.previousPhase = item.phase; item.phase = 'dismissed'; item.undoUntil = clock() + 60000;
                state.receipts[message.id] = { owner: item.owner, cid: item.cid, dismissed: true, date: item.summary?.date || '' }; });
            await reconcile(); return { ok: true };
        },
        GARMIN_UNDO: async message => {
            await store.mutate(state => { const item = state.items[message.id];
                if (!item || item.phase !== 'dismissed' || item.undoUntil <= clock()) throw new GarminError('handoff');
                item.revision = (item.revision || 0) + 1;
                item.phase = item.previousPhase || 'waiting';
                if (item.phase === 'waiting') state.preparePending = true;
                delete item.undoUntil; delete item.previousPhase; delete state.receipts[message.id]; });
            await reconcile();
            return { ok: true };
        },
        GARMIN_DONE: async message => {
            await store.mutate(state => { const item = state.items[message.id]; if (!item) return;
                state.receipts[message.id] = { ...state.receipts[message.id], owner: item.owner, cid: item.cid, complete: true, date: item.summary?.date || '' }; delete state.items[message.id]; });
            await store.mutate(state => { if (state.error?.code === 'capacity') state.error = null; });
            await reconcile(); return { ok: true };
        },
        GARMIN_RETRY: async message => {
            await store.mutate(state => { const item = state.items[message.id];
                if (item?.handoff) throw new GarminError('handoff');
                if (item && item.phase !== 'dismissed') { item.revision = (item.revision || 0) + 1; item.phase = 'waiting'; item.retryAt = 0; } });
            void check(false, false, { resume: true }); return { ok: true };
        },
        GARMIN_OPEN_DRAFTS: (message, sender) => openDrafts(message, sender),
    };
    return { store, connect, disconnect, check, reconcile, snapshot, settingsChanged, peakbaggerVisited,
        async accessChanged() {
            if (await permission()) return reconcile();
            controller?.abort(); client = null; clientEpoch = -1;
            await store.mutate(state => { state.epoch++; state.error = { code: 'permission', message: new GarminError('permission').message }; });
            await reconcile();
        },
        async readSnapshot() { const state = await store.read(); return { epoch: state.credentialEpoch || 0, connection: state.connection }; },
        async verifyImportedKey(key, previous) {
            if (key === null) return previous.connection ? { ...previous.connection, key: null, enabled: false } : null;
            if (!await permission()) throw new GarminError('permission');
            const account = await identity(clientFactory({ key }));
            if (previous.connection && (previous.connection.subject || previous.connection.owner) !== account.subject) throw new GarminError('identity');
            return { ...previous.connection, key, ...account, connectedDate: previous.connection?.connectedDate || date(), enabled: previous.connection?.enabled === true };
        },
        async replaceIfSnapshot(expected, replacement) {
            let result;
            await store.mutate(state => {
                if ((state.credentialEpoch || 0) !== expected.epoch || JSON.stringify(state.connection) !== JSON.stringify(expected.connection)) {
                    result = { replaced: false }; return;
                }
                state.epoch++; state.credentialEpoch = expected.epoch + 1; state.connection = replacement;
                state.scan = null; state.error = null; state.retryAt = 0; result = { replaced: true };
            });
            if (result.replaced) { controller?.abort(); clientEpoch = -1; client = null; await reconcile(); }
            return result;
        },
        async reserveCapture(job) {
            await store.mutate(state => {
                const receipt = state.receipts[job.activityId];
                if (state.items[job.activityId] || (receipt && receipt.jobId !== job.id)) throw new GarminError('duplicate');
                state.receipts[job.activityId] ||= { fromToolbar: true, jobId: job.id, cid: job.cid, peaks: {} };
            });
        },
        async captureSaved(job, peakId, aid) {
            await store.mutate(state => {
                const receipt = state.receipts[job.activityId];
                if (receipt?.jobId !== job.id || String(receipt.cid) !== String(job.cid)) return;
                receipt.peaks[peakId] = aid;
                receipt.complete = job.selectedIds.every(id => receipt.peaks[String(id)]);
            });
        },
        async handle(message, sender) {
            if (!Object.hasOwn(handlers, message?.type)) return null;
            const navigation = ['GARMIN_SUMMARY', 'GARMIN_INBOX_OPEN'].includes(message.type);
            if (!trusted(sender) && !(navigation && popup(sender))) return { ok: false, error: { message: 'Open Garmin Settings or the activity inbox to continue.' } };
            try {
                if (!['GARMIN_STATUS', 'GARMIN_SUMMARY'].includes(message.type) && !(await settings.requireCurrent()).enableGarminInbox) throw new GarminError('disabled');
                return await handlers[message.type](message, sender);
            }
            catch (error) { return { ok: false, error: { code: error instanceof GarminError ? error.code : 'garmin-failed', message: error instanceof GarminError ? error.message : 'Garmin could not finish this action. Your existing drafts are safe.' } }; }
        },
        async saved(activityId, peakId, aid, jobId, cid) {
            if (!positiveId(activityId) || !positiveId(peakId) || !positiveId(aid)) return;
            await store.mutate(state => { const item = state.items[activityId]; if (!item) return;
                if (jobId && (item.handoff?.jobId !== jobId || String(item.cid) !== cid)) return;
                item.saved = [...new Set([...item.saved, peakId])];
                const receipt = state.receipts[activityId] ||= { owner: item.owner, cid: item.cid, peaks: {}, date: item.summary?.date || '' };
                receipt.peaks[peakId] = aid;
                if (item.analysis?.matches.every(match => item.saved.includes(String(match.id)))) { delete state.items[activityId]; receipt.complete = true; }
                if (state.error?.code === 'capacity' && Object.keys(state.items).length < 200) state.error = null;
            });
            await reconcile();
        },
    };
}
