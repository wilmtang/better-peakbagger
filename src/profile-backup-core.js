// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure profile-backup primitives shared by the ClimbListC content script and
// fixture/unit tests. No extension APIs or ambient document are read here.

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const numericParam = (href, name, base = 'https://peakbagger.com/') => {
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

const ownerClimberId = doc => {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const owner = links.find(anchor => /^My Ascents$/i.test(trim(anchor.textContent)))
        || links.find(anchor => /^Add Ascent$/i.test(trim(anchor.textContent)));
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
const classifyResponse = (status, headers, bodyText, { kind = 'edit' } = {}) => {
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
    return /<form\b[^>]*(?:id|name)=["']Form1["']/i.test(body)
        && /\bJournalText\b/i.test(body)
        && /\bDateText\b/i.test(body)
        && /\bPeakListBox\b/i.test(body)
        ? 'ok' : 'wrong-content';
};

const failureReason = result => trim(result && result.reason) || 'Peakbagger returned unexpected content.';

const createRunner = ({
    ascents,
    existingFolders = [],
    refreshAll = false,
    loadItem,
    pushItem,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onState = () => {},
    paceMs = 2000,
    retryDelays = [4000, 15000],
    transientPauseAfter = 2,
} = {}) => {
    if (typeof loadItem !== 'function' || typeof pushItem !== 'function') {
        throw new TypeError('profile backup runner requires loadItem and pushItem');
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
        pauseReason: null,
        challengeUrl: null,
        notReached: work.length,
    };
    let index = 0;
    let cancelled = false;
    let pauseRequested = false;
    let challengeProbeUrl = null;
    let challenged = false;
    let consecutiveTransientFailures = 0;
    let activeRun = null;

    const publish = patch => {
        Object.assign(state, patch);
        state.notReached = Math.max(0, work.length - index);
        onState({ ...state, failures: state.failures.slice() });
    };
    const recordFailure = (item, reason, kind = 'wrong-content') => {
        state.failures.push({ aid: item.aid, peakName: item.peakName || '', ascentUrl: item.ascentUrl || '', reason, kind });
        index += 1;
        publish({ completed: state.completed + 1 });
    };
    const safeLoad = async (item, options) => {
        try { return await loadItem(item, options); }
        catch (error) { return { kind: 'transient', reason: error && error.message ? error.message : 'Network request failed.' }; }
    };

    const perform = async () => {
        if (cancelled) { publish({ status: 'cancelled', current: null }); return { ...state }; }
        publish({ status: 'running', pauseReason: null, challengeUrl: null });
        while (index < work.length) {
            if (cancelled) { publish({ status: 'cancelled', current: null }); break; }
            if (pauseRequested) { publish({ status: 'paused', pauseReason: 'user', current: null }); break; }

            const item = work[index];
            publish({ current: item });
            let loaded;
            let transientAttempts = 0;
            while (true) {
                loaded = await safeLoad(item, { probe: !!challengeProbeUrl, probeUrl: challengeProbeUrl });
                challengeProbeUrl = null;
                if (loaded && loaded.kind === 'transient' && transientAttempts < retryDelays.length) {
                    await sleep(retryDelays[transientAttempts]);
                    transientAttempts += 1;
                    continue;
                }
                break;
            }

            // A fetch already in flight cannot be undone, but cancellation must
            // still stop before the GitHub write boundary.
            if (cancelled) { publish({ status: 'cancelled', current: null }); break; }

            if (loaded && loaded.kind === 'challenged') {
                challenged = true;
                challengeProbeUrl = loaded.url || item.editUrl || null;
                publish({
                    status: 'paused',
                    pauseReason: 'challenge',
                    challengeUrl: challengeProbeUrl,
                });
                break;
            }
            if (loaded && loaded.kind === 'transient') {
                consecutiveTransientFailures += 1;
                recordFailure(item, failureReason(loaded), 'transient');
                if (consecutiveTransientFailures >= transientPauseAfter && index < work.length) {
                    publish({ status: 'paused', pauseReason: 'transient', current: null });
                    break;
                }
            } else if (!loaded || loaded.kind !== 'ok') {
                consecutiveTransientFailures = 0;
                recordFailure(item, failureReason(loaded));
            } else {
                consecutiveTransientFailures = 0;
                let pushed;
                try { pushed = await pushItem(item, loaded.data); }
                catch (error) { pushed = { ok: false, error: { message: error && error.message } }; }
                if (!pushed || !pushed.ok) {
                    const error = pushed && pushed.error;
                    recordFailure(item, trim(error && error.message) || trim(error && error.code) || 'GitHub backup failed.', 'github');
                } else {
                    index += 1;
                    publish({ completed: state.completed + 1, backedUp: state.backedUp + 1 });
                }
            }
            if (index < work.length && !cancelled && !pauseRequested) await sleep(challenged ? paceMs * 2 : paceMs);
        }
        if (index >= work.length && state.status === 'running') publish({ status: 'complete', current: null, notReached: 0 });
        return { ...state, failures: state.failures.slice() };
    };

    return {
        state,
        run() {
            if (!activeRun) activeRun = perform().finally(() => { activeRun = null; });
            return activeRun;
        },
        pause() { if (!cancelled && state.status === 'running') pauseRequested = true; },
        resume() {
            if (cancelled || state.status !== 'paused') return Promise.resolve({ ...state });
            pauseRequested = false;
            return this.run();
        },
        cancel() {
            cancelled = true;
            pauseRequested = false;
            if (!activeRun) publish({ status: 'cancelled', current: null });
        },
    };
};

export const profileBackupCore = {
    parseAscentList,
    ascentIdsFromFolders,
    buildWorkList,
    fullListUrl,
    classifyResponse,
    createRunner,
};
