// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { searchSentinel, sentinelView, sentinelTarget } from './sentinel-core.js';
import { mountainTime } from '../time/mountain-time.js';
import { sentinelCaptureChoice } from './sentinel-layer.js';

export function createSentinelSession({ readView, replaceScenes, clearScenes, onStatus, onCapture = () => {},
    search = searchSentinel, fetchImpl, debounceMs = 300 }) {
    let active = false, disposed = false, revision = 0, controller = null, timer = null;
    let captures = [], target = null, rendered = '', retryAt = 0, tileFailed = false, zone = null, catalogValid = false;
    let status = {};
    let tilePending = false, retrying = false;
    const report = () => {
        if (!status.pending && !tilePending && !status.error) retrying = false;
        onStatus({ ...status, pending: !status.error && (status.pending === true || tilePending), capturePending: status.pending === true,
            retry: status.retry === true || retrying, message: tilePending && !status.pending && !status.error ? 'Loading imagery' : status.message });
    };
    const publish = patch => { status = { ...status, ...patch }; report(); };
    const cancel = () => { revision++; controller?.abort(); controller = null; clearTimeout(timer); timer = null; };
    const clear = () => { rendered = ''; tileFailed = false; tilePending = false; clearScenes(); };
    const choose = (retry = false) => {
        const current = target ? captures.find(candidate => candidate.platform === target.platform
            && candidate.orbit === target.orbit && Math.abs(candidate.time - target.time) <= 900000) : captures[0];
        const option = (capture, id, latest = false) => sentinelCaptureChoice(capture, zone, id, latest);
        const choices = [captures[0] ? option(captures[0], 'latest', true) : { id: 'latest', label: 'Latest capture' },
            ...captures.slice(1).map(capture => option(capture, capture.key))];
        if (target && !current) choices.push(option(target, 'missing'));
        if (current) {
            const key = JSON.stringify(current.scenes.map(scene => [scene.id, scene.bounds]).sort());
            if (key !== rendered || retry && tileFailed) { tileFailed = false; replaceScenes(current.scenes); tilePending = true; rendered = key; }
        } else clear();
        publish({ pending: false, error: tileFailed, retry: tileFailed, retryAt: 0, captures: choices,
            capture: target && current !== captures[0] ? current?.key || 'missing' : 'latest',
            message: current ? `Coverage ${Math.round(current.coverage * 100)}% · Clouds ${Number.isFinite(current.cloud) ? `${Math.round(current.cloud)}%` : 'unknown'}`
                : target ? 'This capture does not cover the view.' : 'No captures in the past 30 days.' });
    };
    const load = async (retry = false) => {
        if (!active || disposed || retryAt > Date.now()) return;
        cancel(); catalogValid = false; const owner = revision; controller = new AbortController();
        publish({ pending: true, error: false, message: 'Finding captures…' });
        let valid = false;
        try {
            const view = readView(), bounds = sentinelView(view.bounds, view.zoom); valid = true;
            const nextZone = mountainTime.resolve((bounds.south + bounds.north) / 2, ((bounds.west + bounds.east) / 2 + 180) % 360 - 180);
            const result = await search(bounds, { signal: controller.signal, fetchImpl });
            if (owner !== revision || !active) return;
            zone = nextZone; captures = result; catalogValid = true; choose(retry);
        } catch (error) {
            if (owner !== revision || !active || error.name === 'AbortError') return;
            if (!valid) clear();
            if (error.code === 'rate-limit') retryAt = error.retryAt || Date.now() + 300000;
            publish({ pending: false, error: true, retry: true, retryAt,
                message: error.code === 'rate-limit' ? 'Satellite service is busy. Try again later.'
                    : !valid ? error.message.slice(0, 80) : rendered ? 'Capture search failed. Previous imagery shown.' : 'Captures unavailable. Retry.' });
        } finally { if (owner === revision) controller = null; }
    };
    return {
        activate(capture) {
            const previous = JSON.stringify(target);
            if (capture !== undefined) target = sentinelTarget(capture);
            if (active) { if (previous !== JSON.stringify(target)) { if (catalogValid) choose(); else void load(); } return; }
            active = true; void load();
        },
        deactivate() { active = false; tilePending = false; retrying = false; cancel(); clear(); publish({ pending: false }); },
        refresh() {
            if (!active || retryAt > Date.now()) return;
            cancel(); catalogValid = false; publish({ pending: true, error: false, message: 'Finding captures…' });
            timer = setTimeout(() => void load(), debounceMs);
        },
        select(value) {
            if (!active) return;
            if (value === 'latest') target = null;
            else { const capture = captures.find(candidate => candidate.key === value); if (!capture) return; target = sentinelTarget(capture); }
            onCapture(target); if (catalogValid) choose(); else void load();
        },
        retry() { retrying = true; void load(true); },
        cooldown(value) {
            if (!Number.isFinite(value) || value <= Date.now() || value <= retryAt) return;
            retryAt = value; cancel();
            publish({ pending: false, error: true, retry: true, retryAt, message: 'Satellite service is busy. Try again later.' });
        },
        tileError(error) {
            if (!active) return;
            tileFailed = true;
            if (error?.code === 'rate-limit') { retryAt = error.retryAt; cancel(); }
            publish({ error: true, pending: false, retry: true, retryAt, message: 'Imagery tiles unavailable. Change capture or Retry.' });
        },
        tileActivity(activity) { if (!active) return; tilePending = activity.pending; report(); },
        dispose() { disposed = true; active = false; cancel(); clear(); },
    };
}
