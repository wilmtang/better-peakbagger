// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { searchSentinel, sentinelView, sentinelTarget } from './sentinel-core.js';
import { rateLimitMessage } from '../net/rate-limit.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';

const captureDate = time => new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// Both map engines share request ownership, capture choice, and honest metadata
// labels. Engine adapters own only adding/removing their extension-owned tiles.
export const createSentinelLayer = ({ document: ownerDocument, readView, replaceScenes, clearScenes,
    fetchImpl, search = searchSentinel, debounceMs = 300, onCaptureChange = () => {} } = {}) => {
    const element = ownerDocument.createElement('div');
    element.className = 'bpb-sentinel';
    element.hidden = true;
    const select = ownerDocument.createElement('select');
    select.setAttribute('aria-label', 'Sentinel-2 capture');
    const summary = ownerDocument.createElement('p');
    summary.className = 'bpb-sentinel-summary';
    summary.setAttribute('role', 'status');
    const stats = ownerDocument.createElement('p');
    stats.className = 'bpb-sentinel-stats';
    stats.setAttribute('role', 'status');
    stats.title = 'Map coverage estimates how much of the area shown falls within this capture\'s satellite images. Clouds or gaps can still obscure covered areas. Cloud cover is averaged across the full satellite images.';
    const retry = ownerDocument.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.hidden = true;
    element.append(select, summary, stats, retry);
    let active = false;
    let revision = 0;
    let controller = null;
    let timer = null;
    let captures = [];
    let target = null;
    let limit = null;
    const cooldown = createRetryCooldown(blocked => { retry.disabled = blocked; });
    const showLimit = error => {
        limit = error;
        summary.hidden = false;
        summary.dataset.kind = 'rate-limit';
        summary.textContent = rateLimitMessage('Microsoft Planetary Computer', error.retryAt);
        retry.hidden = false;
        cooldown.set(error.retryAt);
    };

    const clearRequest = () => {
        revision++;
        controller?.abort();
        controller = null;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const renderCapture = capture => {
        if (!capture) {
            clearScenes();
            summary.hidden = false;
            summary.textContent = target ? 'This capture does not cover the current view.' : 'No captures found in the last 30 days.';
            stats.textContent = '';
            return;
        }
        replaceScenes(capture.scenes);
        summary.hidden = !!target;
        summary.textContent = captureDate(capture.time);
        stats.textContent = `Map coverage ${Math.round(capture.coverage * 100)}% · Cloud cover ${capture.cloud === null ? 'unknown' : Math.round(capture.cloud) + '%'}`;
    };
    const choose = () => {
        const capture = target ? captures.find(candidate => candidate.platform === target.platform
            && candidate.orbit === target.orbit && Math.abs(candidate.time - target.time) <= 15 * 60000) : captures[0];
        const options = [];
        const latest = ownerDocument.createElement('option');
        latest.value = 'latest';
        latest.textContent = 'Latest capture';
        options.push(latest);
        for (const candidate of captures) {
            const option = ownerDocument.createElement('option');
            option.value = candidate.key;
            option.textContent = captureDate(candidate.time);
            options.push(option);
        }
        if (target && !capture) {
            const missing = ownerDocument.createElement('option');
            missing.value = 'missing';
            missing.textContent = captureDate(target.time);
            options.push(missing);
        }
        select.replaceChildren(...options);
        select.value = target ? capture?.key || 'missing' : 'latest';
        select.disabled = false;
        renderCapture(capture);
    };
    const load = async () => {
        if (!active) return;
        if (cooldown.active()) return;
        limit = null;
        delete summary.dataset.kind;
        clearRequest();
        const current = revision;
        controller = new AbortController();
        summary.textContent = 'Finding captures…';
        summary.hidden = false;
        stats.textContent = '';
        retry.hidden = true;
        select.disabled = true;
        try {
            const view = readView();
            const bounds = sentinelView(view.bounds, view.zoom);
            const result = await search(bounds, { signal: controller.signal, fetchImpl });
            if (!active || revision !== current) return;
            captures = result;
            choose();
        } catch (error) {
            if (!active || revision !== current || error?.name === 'AbortError') return;
            clearScenes();
            captures = [];
            summary.hidden = false;
            summary.textContent = error?.name === 'TimeoutError' ? 'Satellite service took too long. Try again.'
                : error instanceof SyntaxError ? 'Satellite service returned an invalid catalog.'
                    : error?.message || 'Satellite imagery is unavailable. Try again.';
            stats.textContent = '';
            retry.hidden = false;
            if (error?.code === 'rate-limit') showLimit(error);
        }
    };
    select.addEventListener('change', () => {
        target = select.value === 'latest' ? null : captures.find(capture => capture.key === select.value) || target;
        onCaptureChange(sentinelTarget(target));
        retry.hidden = true;
        choose();
        if (limit) showLimit(limit);
    });
    retry.addEventListener('click', () => { void load(); });
    return {
        element,
        activate(capture) {
            if (capture !== undefined) target = sentinelTarget(capture);
            active = true;
            cooldown.resume();
            element.hidden = false;
            if (cooldown.active()) { showLimit(limit || {}); return; }
            void load();
        },
        refresh() {
            if (!active || limit) return;
            clearRequest();
            summary.textContent = 'Finding captures…';
            summary.hidden = false;
            stats.textContent = '';
            select.disabled = true;
            timer = setTimeout(() => { void load(); }, debounceMs);
        },
        deactivate() { active = false; clearRequest(); cooldown.suspend(); element.hidden = true; clearScenes(); },
        tileError(error) {
            if (!active) return;
            if (error?.status === 429) { showLimit(error); return; }
            if (limit) return;
            summary.hidden = false;
            summary.textContent = 'Some imagery tiles are unavailable. Choose another capture or try again.';
            retry.hidden = false;
        },
        dispose() { active = false; clearRequest(); cooldown.dispose(); clearScenes(); element.remove(); }
    };
};
