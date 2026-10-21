// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { searchSentinel, sentinelView, sentinelTarget } from './sentinel-core.js';
import { rateLimitMessage } from '../net/rate-limit.js';
import { createRetryCooldown } from '../ui/retry-cooldown.js';
import { mountainTime } from '../time/mountain-time.js';

export const captureDate = (time, zone, includeZone = true) => {
    const date = mountainTime.localDate(zone, time);
    const minute = mountainTime.localMinute(zone, time);
    if (!date || minute === null) {
        if (zone?.timeZone) return captureDate(time, { timeZone: null, offsetMs: zone.offsetMs }, includeZone);
        return new Date(time).toISOString().slice(0, 16).replace('T', ' ') + (includeZone ? ' UTC' : '');
    }
    const pad = value => String(value).padStart(2, '0');
    return `${date} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}${includeZone ? ` ${mountainTime.zoneLabel(zone, time)}` : ''}`;
};

const cloudCover = cloud => Number.isFinite(cloud) ? Math.round(cloud) + '%' : 'unknown';

// Both map engines share request ownership, capture choice, and honest metadata
// labels. Engine adapters own only adding/removing their extension-owned tiles.
export const createSentinelLayer = ({ document: ownerDocument, readView, replaceScenes, clearScenes,
    fetchImpl, search = searchSentinel, debounceMs = 300, onCaptureChange = () => {} } = {}) => {
    const element = ownerDocument.createElement('div');
    element.className = 'bpb-sentinel';
    element.hidden = true;
    const select = ownerDocument.createElement('select');
    select.setAttribute('aria-label', 'Sentinel-2 capture');
    const initialOption = ownerDocument.createElement('option');
    initialOption.value = 'latest';
    initialOption.textContent = 'Latest capture';
    select.append(initialOption);
    const metadata = ownerDocument.createElement('div');
    metadata.className = 'bpb-sentinel-metadata';
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
    metadata.append(summary, stats);
    // Feedback and retry grow above the bottom-anchored picker. The top-anchored
    // terrain control reverses that order without reserving an empty retry row.
    element.append(metadata, select, retry);
    let active = false;
    let revision = 0;
    let controller = null;
    let timer = null;
    let captures = [];
    let renderedScenes = null;
    let failedImagery = false;
    let captureZone = null;
    let target = null;
    let limit = null;
    let loading = false;
    const cooldown = createRetryCooldown(blocked => { retry.disabled = blocked || loading; });
    const showLoading = () => {
        loading = true;
        // Retain the current feedback height while a request is pending. A
        // successful response can then deliberately collapse to the compact UI.
        metadata.style.minHeight = `${metadata.offsetHeight}px`;
        summary.textContent = 'Finding captures…';
        summary.hidden = false;
        stats.textContent = '';
        select.disabled = true;
        retry.disabled = true;
    };
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
    const clearRenderedScenes = () => {
        renderedScenes = null;
        failedImagery = false;
        clearScenes();
    };
    const imageryFailureMessage = 'Some imagery tiles are unavailable. Choose another capture or try again.';
    const renderCapture = (capture, retryImagery = false) => {
        if (!capture) {
            clearRenderedScenes();
            summary.hidden = false;
            summary.textContent = target ? 'This capture does not cover the current view.' : 'No captures found in the last 30 days.';
            stats.textContent = '';
            return;
        }
        // Camera movement changes coverage and can reorder the same pass's
        // scenes. Keep its sources and decoded tiles instead of exposing the
        // underlying map while identical imagery is requested again.
        const scenes = JSON.stringify(capture.scenes.map(scene => [scene.id, scene.bounds])
            .sort(([left], [right]) => left.localeCompare(right)));
        if (scenes !== renderedScenes || (retryImagery && failedImagery)) {
            failedImagery = false;
            replaceScenes(capture.scenes);
            renderedScenes = scenes;
        }
        summary.hidden = !failedImagery;
        summary.textContent = failedImagery ? imageryFailureMessage : captureDate(capture.time, captureZone);
        if (failedImagery) retry.hidden = false;
        stats.textContent = `Coverage ${Math.round(capture.coverage * 100)}% · Clouds ${cloudCover(capture.cloud)}`;
    };
    const captureOption = (capture, value, latest = false) => {
        const option = ownerDocument.createElement('option');
        option.value = value;
        const date = captureDate(capture.time, captureZone, false);
        const cloud = cloudCover(capture.cloud);
        // Keep the native picker compact; its tooltip and accessible label retain
        // the full year, timezone, and meaning of the cloud percentage.
        option.textContent = `${latest ? `Latest · ${date.slice(5)}` : date} · ☁ ${cloud === 'unknown' ? '?' : cloud}`;
        option.title = `${latest ? 'Latest · ' : ''}${captureDate(capture.time, captureZone)} · Clouds ${cloud}`;
        option.setAttribute('aria-label', option.title);
        return option;
    };
    const choose = (retryImagery = false) => {
        const capture = target ? captures.find(candidate => candidate.platform === target.platform
            && candidate.orbit === target.orbit && Math.abs(candidate.time - target.time) <= 15 * 60000) : captures[0];
        const options = [];
        const latest = captures[0] ? captureOption(captures[0], 'latest', true) : ownerDocument.createElement('option');
        if (!captures[0]) { latest.value = 'latest'; latest.textContent = 'Latest capture'; }
        options.push(latest);
        // The latest option already represents the first capture. Keep only
        // older captures as dated choices, including when a pinned date becomes
        // the newest capture in a different view.
        for (const candidate of captures.slice(1)) {
            options.push(captureOption(candidate, candidate.key));
        }
        if (target && !capture) {
            options.push(captureOption(target, 'missing'));
        }
        select.replaceChildren(...options);
        select.value = target && (!capture || capture !== captures[0]) ? capture?.key || 'missing' : 'latest';
        select.title = select.selectedOptions[0]?.title || select.selectedOptions[0]?.textContent || '';
        select.disabled = false;
        renderCapture(capture, retryImagery);
    };
    const load = async ({ retryImagery = false } = {}) => {
        if (!active) return;
        if (cooldown.active()) return;
        limit = null;
        delete summary.dataset.kind;
        clearRequest();
        const current = revision;
        controller = new AbortController();
        showLoading();
        let validView = false;
        try {
            const view = readView();
            const bounds = sentinelView(view.bounds, view.zoom);
            validView = true;
            // Use the displayed mountain area, including wrapped map copies;
            // commit its zone with the catalog so stale searches cannot relabel it.
            const longitude = ((bounds.west + bounds.east) / 2 + 180) % 360 - 180;
            const zone = mountainTime.resolve((bounds.south + bounds.north) / 2, longitude);
            const result = await search(bounds, { signal: controller.signal, fetchImpl });
            if (!active || revision !== current) return;
            captures = result;
            captureZone = zone;
            retry.hidden = true;
            choose(retryImagery);
        } catch (error) {
            if (!active || revision !== current || error?.name === 'AbortError') return;
            // A catalog error says nothing about already loaded imagery. Clear
            // it only when the view itself is unsupported; old coverage remains
            // unknown until a successful catalog refresh, so stats stay empty.
            const retained = validView && renderedScenes !== null && renderedScenes !== '[]';
            if (!retained) clearRenderedScenes();
            captures = [];
            summary.hidden = false;
            summary.textContent = error?.name === 'TimeoutError' ? 'Satellite service took too long. Try again.'
                : error instanceof SyntaxError ? 'Satellite service returned an invalid catalog.'
                    : error?.message || 'Satellite imagery is unavailable. Try again.';
            if (retained) summary.textContent += ' Showing previous imagery.';
            stats.textContent = '';
            retry.hidden = false;
            if (error?.code === 'rate-limit') showLimit(error);
        } finally {
            if (revision === current) {
                loading = false;
                metadata.style.minHeight = '';
                cooldown.refresh();
            }
        }
    };
    select.addEventListener('change', () => {
        target = select.value === 'latest' ? null : captures.find(capture => capture.key === select.value) || target;
        onCaptureChange(sentinelTarget(target));
        retry.hidden = true;
        choose();
        if (limit) showLimit(limit);
    });
    retry.addEventListener('click', () => { void load({ retryImagery: true }); });
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
            showLoading();
            timer = setTimeout(() => { void load(); }, debounceMs);
        },
        deactivate() { active = false; clearRequest(); cooldown.suspend(); element.hidden = true; clearRenderedScenes(); },
        tileError(error) {
            if (!active) return;
            failedImagery = true;
            if (error?.status === 429) { showLimit(error); return; }
            if (limit) return;
            summary.hidden = false;
            summary.textContent = imageryFailureMessage;
            retry.hidden = false;
        },
        dispose() { active = false; clearRequest(); cooldown.dispose(); clearRenderedScenes(); element.remove(); }
    };
};
