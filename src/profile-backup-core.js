// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure profile-backup primitives shared by the ClimbListC content script and
// fixture/unit tests. No extension APIs or ambient document are read here.

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export const numericParam = (href, name, base = 'https://peakbagger.com/') => {
    try {
        const raw = new URL(href, base).searchParams.get(name);
        return /^-?\d+$/.test(raw || '') ? Number(raw) : null;
    } catch { return null; }
};

const findLink = (row, pathPattern) => Array.from(row.querySelectorAll('a[href]')).find(anchor => {
    if (anchor.closest('tr') !== row) return false;
    try { return pathPattern.test(new URL(anchor.href, 'https://peakbagger.com/').pathname); }
    catch { return false; }
}) || null;

export const ownerClimberId = doc => {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const owner = links.find(anchor => /^My Ascents$/i.test(trim(anchor.textContent)))
        || links.find(anchor => /^Add Ascent$/i.test(trim(anchor.textContent)))
        || links.find(anchor => /^My Home Page$/i.test(trim(anchor.textContent)));
    return owner ? numericParam(owner.href, 'cid', doc.baseURI) : null;
};

const dateFromText = value => {
    const text = trim(value);
    const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    return match ? match[0] : '';
};

const parseAscentList = (doc, { url = doc && doc.baseURI } = {}) => {
    if (!doc || !doc.querySelectorAll) return { isOwner: false, climberId: null, ascents: [] };
    const pageClimberId = numericParam(url, 'cid', doc.baseURI);
    const ownerId = ownerClimberId(doc);
    const ascents = [];

    for (const row of doc.querySelectorAll('tr')) {
        const ascentLink = findLink(row, /\/climber\/ascent\.aspx$/i);
        const peakLink = findLink(row, /\/peak\.aspx$/i);
        if (!ascentLink || !peakLink) continue;
        const editLink = findLink(row, /\/climber\/ascentedit\.aspx$/i);
        const aid = numericParam(ascentLink.href, 'aid', doc.baseURI);
        const pid = numericParam(peakLink.href, 'pid', doc.baseURI);
        if (aid == null || pid == null) continue;
        const trMatch = Array.from(row.cells).map(cell => /^TR-(\d+)$/i.exec(trim(cell.textContent))).find(Boolean);
        const hasGpx = Array.from(row.querySelectorAll('img')).some(image =>
            /(?:^|\/)gps\.gif(?:$|[?#])/i.test(image.src || image.getAttribute('src') || '')
            || /ascent has (?:a )?gps track/i.test(image.title || ''));
        ascents.push({
            aid,
            pid,
            peakName: trim(peakLink.textContent),
            date: dateFromText(ascentLink.textContent),
            hasGpx,
            trWords: trMatch ? Number(trMatch[1]) : 0,
            ascentUrl: ascentLink.href,
            editUrl: editLink ? editLink.href : null,
        });
    }

    const isOwner = ownerId != null
        && pageClimberId === ownerId
        && ascents.every(ascent => ascent.editUrl);
    return { isOwner, climberId: isOwner ? ownerId : null, ascents: isOwner ? ascents : [] };
};

const ascentIdsFromFolders = folders => new Set((Array.isArray(folders) ? folders : []).flatMap(folder => {
    const leaf = typeof folder === 'string' ? folder : folder && typeof folder.path === 'string' ? folder.path : '';
    const match = /-a(\d+)$/.exec(leaf);
    return match ? [Number(match[1])] : [];
}));

const buildWorkList = (ascents, folders, { refreshAll = false } = {}) => {
    const existing = ascentIdsFromFolders(folders);
    const seen = new Set();
    const unique = (Array.isArray(ascents) ? ascents : []).filter(ascent => {
        if (!ascent || !Number.isFinite(ascent.aid) || seen.has(ascent.aid)) return false;
        seen.add(ascent.aid);
        return true;
    });
    const skipped = refreshAll ? [] : unique.filter(ascent => existing.has(ascent.aid));
    const work = refreshAll ? unique : unique.filter(ascent => !existing.has(ascent.aid));
    return { work, skipped, existing };
};

const fullListUrl = rawUrl => {
    const url = new URL(rawUrl);
    url.searchParams.set('j', '-1');
    url.searchParams.set('y', '9999');
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'AscentDate');
    return url.toString();
};

const headerValue = (headers, name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return trim(headers.get(name));
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? trim(headers[key]) : '';
};

const CHALLENGE_MARKERS = [
    /\bcf-chl-/i,
    /\b_cf_chl_opt\b/i,
    /challenge-platform/i,
    /cloudflare[^<]{0,80}(?:challenge|human|verification)/i,
    /<title>\s*just a moment/i,
    /attention required[^<]{0,80}cloudflare/i,
];

// Classify a completed Peakbagger response without trusting status alone. A
// 200 login/challenge page is not ascent data, and must never reach the backup.
// Exported by name as well as on the object below so the per-save ascent backup
// can share the exact classifier without pulling the whole runner into its
// bundle (esbuild tree-shakes the rest away for a named import).
export const classifyResponse = (status, headers, bodyText, { kind = 'edit' } = {}) => {
    const body = typeof bodyText === 'string' ? bodyText : '';
    if (/challenge/i.test(headerValue(headers, 'cf-mitigated'))
        || CHALLENGE_MARKERS.some(pattern => pattern.test(body))
        || status === 403 || status === 429 || status === 503) return 'challenged';
    if (status === 0 || status >= 500) return 'transient';
    if (status < 200 || status >= 300) return 'wrong-content';
    if (kind === 'gpx') return /<gpx\b/i.test(body) ? 'ok' : 'wrong-content';
    if (kind === 'list') {
        return /ClimbListC\.aspx/i.test(body) && /(?:My Ascents|Ascent List)/i.test(body)
            ? 'ok' : 'wrong-content';
    }
    if (kind === 'buddies') {
        return /\bid=["']RGridView["']/i.test(body) && /Buddy List/i.test(body)
            ? 'ok' : 'wrong-content';
    }
    if (kind === 'climber') {
        return /<h1\b[^>]*>/i.test(body) && /ClimbListC\.aspx\?[^"'<>]*\bcid=\d+/i.test(body)
            ? 'ok' : 'wrong-content';
    }
    return /<form\b[^>]*(?:id|name)=["']Form1["']/i.test(body)
        && /\bJournalText\b/i.test(body)
        && /\bDateText\b/i.test(body)
        && /\bPeakListBox\b/i.test(body)
        ? 'ok' : 'wrong-content';
};

const failureReason = result => trim(result && result.reason) || 'Peakbagger returned unexpected content.';

const DEFAULT_BATCH_ITEMS = 10;
const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_BUFFER_ITEMS = 30;
const DEFAULT_BUFFER_BYTES = 32 * 1024 * 1024;

const utf8Bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : '').byteLength;
const backupPayloadBytes = data => {
    let snapshot = '';
    try { snapshot = JSON.stringify(data && data.snapshot ? data.snapshot : null); }
    catch { snapshot = ''; }
    return utf8Bytes(snapshot) + utf8Bytes(data && data.gpx);
};

const createRunner = ({
    ascents,
    existingFolders = [],
    refreshAll = false,
    loadItem,
    pushBatch,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onState = () => {},
    paceMs = 2000,
    retryDelays = [4000, 15000],
    transientPauseAfter = 2,
    batchItems = DEFAULT_BATCH_ITEMS,
    batchBytes = DEFAULT_BATCH_BYTES,
    bufferItems = DEFAULT_BUFFER_ITEMS,
    bufferBytes = DEFAULT_BUFFER_BYTES,
    measureItem = backupPayloadBytes,
} = {}) => {
    if (typeof loadItem !== 'function' || typeof pushBatch !== 'function') {
        throw new TypeError('profile backup runner requires loadItem and pushBatch');
    }
    for (const [name, value] of Object.entries({ batchItems, batchBytes, bufferItems, bufferBytes })) {
        if (!Number.isFinite(value) || value <= 0) throw new TypeError(`profile backup runner requires positive ${name}`);
    }
    if (batchItems > bufferItems || batchBytes > bufferBytes) {
        throw new TypeError('profile backup batch limits must fit inside the buffer limits');
    }
    const { work, skipped } = buildWorkList(ascents, existingFolders, { refreshAll });
    const state = {
        status: 'idle',
        total: work.length + skipped.length,
        queued: work.length,
        completed: skipped.length,
        backedUp: 0,
        skipped: skipped.length,
        failures: [],
        current: null,
        fetched: 0,
        buffered: 0,
        bufferedBytes: 0,
        uploading: 0,
        producerWaiting: false,
        pauseReason: null,
        pauseError: null,
        pauseBatchSize: 0,
        challengeUrl: null,
        notReached: work.length,
    };
    let nextLoadIndex = 0;
    const buffer = [];
    let bufferedByteCount = 0;
    let producerDone = false;
    let cancelled = false;
    let pauseRequested = false;
    let challengeProbeUrl = null;
    let challenged = false;
    let consecutiveTransientFailures = 0;
    let activeRun = null;
    let halt = null;
    const waiters = new Set();

    const notify = () => {
        for (const resolve of waiters) resolve();
        waiters.clear();
    };
    const waitForChange = () => new Promise(resolve => waiters.add(resolve));

    const publish = patch => {
        Object.assign(state, patch);
        state.buffered = buffer.length;
        state.bufferedBytes = bufferedByteCount;
        state.notReached = Math.max(0, work.length - state.backedUp - state.failures.length);
        onState({ ...state, failures: state.failures.slice() });
    };
    const recordFailure = (item, reason, kind = 'wrong-content') => {
        state.failures.push({ aid: item.aid, peakName: item.peakName || '', ascentUrl: item.ascentUrl || '', reason, kind });
        publish({ completed: state.completed + 1 });
    };
    const safeLoad = async (item, options) => {
        try { return await loadItem(item, options); }
        catch (error) { return { kind: 'transient', reason: error && error.message ? error.message : 'Network request failed.' }; }
    };
    const stopFor = (reason, patch = {}) => {
        if (!halt) halt = { reason, patch };
        notify();
    };
    const isBufferFull = () => buffer.length >= bufferItems || bufferedByteCount >= bufferBytes;
    const nextBatch = () => {
        const selected = [];
        let bytes = 0;
        for (const entry of buffer) {
            if (selected.length >= batchItems) break;
            if (selected.length && bytes + entry.bytes > batchBytes) break;
            selected.push(entry);
            bytes += entry.bytes;
        }
        return selected;
    };

    const produce = async () => {
        while (nextLoadIndex < work.length && !cancelled && !pauseRequested && !halt) {
            while (isBufferFull() && !cancelled && !pauseRequested && !halt) {
                if (!state.producerWaiting) publish({ producerWaiting: true, current: null });
                await waitForChange();
            }
            if (cancelled || pauseRequested || halt) break;

            if (state.producerWaiting) publish({ producerWaiting: false });
            const item = work[nextLoadIndex];
            publish({ current: item });
            let loaded;
            let transientAttempts = 0;
            while (true) {
                loaded = await safeLoad(item, { probe: !!challengeProbeUrl, probeUrl: challengeProbeUrl });
                challengeProbeUrl = null;
                if (loaded && loaded.kind === 'transient' && transientAttempts < retryDelays.length) {
                    await sleep(retryDelays[transientAttempts]);
                    transientAttempts += 1;
                    if (cancelled) break;
                    continue;
                }
                break;
            }

            // A fetch already in flight cannot be undone. Cancellation discards
            // its result before it can enter a GitHub batch; pause/error states
            // retain a completed successful fetch in the bounded buffer.
            if (cancelled) break;

            if (loaded && loaded.kind === 'challenged') {
                challenged = true;
                challengeProbeUrl = loaded.url || item.editUrl || null;
                stopFor('challenge', { challengeUrl: challengeProbeUrl });
            } else if (loaded && loaded.kind === 'transient') {
                consecutiveTransientFailures += 1;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                recordFailure(item, failureReason(loaded), 'transient');
                if (consecutiveTransientFailures >= transientPauseAfter && nextLoadIndex < work.length) {
                    stopFor('transient');
                }
            } else if (!loaded || loaded.kind !== 'ok') {
                consecutiveTransientFailures = 0;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                recordFailure(item, failureReason(loaded));
            } else {
                consecutiveTransientFailures = 0;
                let bytes = Number(measureItem(loaded.data, item));
                if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
                buffer.push({ item, data: loaded.data, bytes });
                bufferedByteCount += bytes;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                notify();
            }
            if (nextLoadIndex < work.length && !cancelled && !pauseRequested && !halt) {
                await sleep(challenged ? paceMs * 2 : paceMs);
            }
        }
        producerDone = nextLoadIndex >= work.length;
        publish({ producerWaiting: false, current: null });
        notify();
    };

    const consume = async () => {
        while (!cancelled && !pauseRequested && !halt) {
            const ready = buffer.length >= batchItems
                || bufferedByteCount >= batchBytes
                || (producerDone && buffer.length > 0);
            if (!ready) {
                if (producerDone && buffer.length === 0) break;
                await waitForChange();
                continue;
            }

            const batch = nextBatch();
            publish({ uploading: batch.length });
            let pushed;
            try { pushed = await pushBatch(batch.map(({ item, data }) => ({ item, data }))); }
            catch (error) { pushed = { ok: false, error: { message: error && error.message } }; }
            if (!pushed || !pushed.ok) {
                const error = pushed && pushed.error;
                const first = batch[0].item;
                publish({ uploading: 0 });
                stopFor('github', {
                    pauseBatchSize: batch.length,
                    pauseError: {
                        aid: first.aid,
                        peakName: first.peakName || '',
                        ascentUrl: first.ascentUrl || '',
                        reason: trim(error && error.message) || trim(error && error.code) || 'GitHub backup failed.',
                        kind: 'github',
                    },
                });
                break;
            }

            buffer.splice(0, batch.length);
            bufferedByteCount = Math.max(0, bufferedByteCount - batch.reduce((sum, entry) => sum + entry.bytes, 0));
            publish({
                uploading: 0,
                completed: state.completed + batch.length,
                backedUp: state.backedUp + batch.length,
            });
            notify();
        }
    };

    const perform = async () => {
        if (cancelled) { publish({ status: 'cancelled', current: null }); return { ...state }; }
        publish({
            status: 'running', pauseReason: null, pauseError: null, pauseBatchSize: 0,
            challengeUrl: null, current: null,
        });
        await Promise.all([produce(), consume()]);
        if (cancelled) publish({ status: 'cancelled', current: null, uploading: 0, producerWaiting: false });
        else if (halt) publish({
            status: 'paused', pauseReason: halt.reason, current: null, uploading: 0,
            producerWaiting: false, ...halt.patch,
        });
        else if (producerDone && buffer.length === 0) publish({ status: 'complete', current: null, notReached: 0 });
        else if (pauseRequested) publish({ status: 'paused', pauseReason: 'user', current: null, uploading: 0, producerWaiting: false });
        return { ...state, failures: state.failures.slice() };
    };

    return {
        state,
        run() {
            if (!activeRun) activeRun = perform().finally(() => { activeRun = null; });
            return activeRun;
        },
        pause() {
            if (!cancelled && state.status === 'running') {
                pauseRequested = true;
                notify();
            }
        },
        resume() {
            if (cancelled || state.status !== 'paused') return Promise.resolve({ ...state });
            pauseRequested = false;
            halt = null;
            return this.run();
        },
        cancel() {
            cancelled = true;
            pauseRequested = false;
            notify();
            if (!activeRun) publish({ status: 'cancelled', current: null });
        },
    };
};

export const profileBackupCore = {
    numericParam,
    ownerClimberId,
    parseAscentList,
    ascentIdsFromFolders,
    buildWorkList,
    fullListUrl,
    classifyResponse,
    createRunner,
    backupPayloadBytes,
    DEFAULT_BATCH_ITEMS,
    DEFAULT_BATCH_BYTES,
    DEFAULT_BUFFER_ITEMS,
    DEFAULT_BUFFER_BYTES,
};
