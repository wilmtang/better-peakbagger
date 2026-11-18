// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    searchSentinel,
    sentinelView,
    sentinelTarget,
    type SentinelBoundsReader,
    type SentinelCapture,
    type SentinelFetch,
    type SentinelScene,
    type SentinelTarget,
    type SentinelViewBounds,
    type SearchSentinelOptions,
} from './sentinel-core.ts';
import { mountainTime, type MountainZone } from '../time/mountain-time.ts';
import { sentinelCaptureChoice } from './sentinel-capture-choice.ts';

export interface SentinelCaptureOption {
    id: string;
    label: string;
    title?: string;
}

export interface SentinelTileActivity {
    pending?: boolean;
    error?: boolean;
    partial?: boolean;
    complete?: boolean;
}

export interface SentinelStatus {
    pending: boolean;
    capturePending: boolean;
    error: boolean;
    captureError: boolean;
    partial: boolean;
    retry: boolean;
    retryAt?: number;
    captures?: SentinelCaptureOption[];
    capture?: string;
    message?: string;
}

export interface SentinelViewInput {
    bounds?: SentinelBoundsReader | null;
    zoom?: number;
}

export interface SentinelSessionOptions {
    readView(): SentinelViewInput;
    replaceScenes(scenes: SentinelScene[]): void;
    clearScenes(): void;
    retryTiles?: () => void;
    onStatus(status: SentinelStatus): void;
    onCapture?: (target: SentinelTarget | null) => void;
    search?: (view: SentinelViewBounds, options?: SearchSentinelOptions) => Promise<SentinelCapture[]>;
    fetchImpl?: SentinelFetch;
    debounceMs?: number;
}

export interface SentinelSession {
    activate(capture?: unknown): void;
    deactivate(): void;
    refresh(): void;
    select(value: string): void;
    retry(): void;
    cooldown(value: number | undefined): void;
    tileError(error: { code?: unknown; retryAt?: number | null } | null | undefined): void;
    tileActivity(activity: SentinelTileActivity): void;
    dispose(): void;
}

interface InternalSentinelStatus {
    pending?: boolean;
    error?: boolean;
    retry?: boolean;
    retryAt?: number;
    captures?: SentinelCaptureOption[];
    capture?: string;
    message?: string;
}

export function createSentinelSession({
    readView,
    replaceScenes,
    clearScenes,
    retryTiles = () => {},
    onStatus,
    onCapture = () => {},
    search = searchSentinel,
    fetchImpl,
    debounceMs = 300,
}: SentinelSessionOptions): SentinelSession {
    let active = false, disposed = false, revision = 0;
    let controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | null = null;
    let captures: SentinelCapture[] = [], target: SentinelTarget | null = null, rendered = '', retryAt = 0;
    let tileFailed = false, zone: MountainZone | null = null, catalogValid = false;
    let status: InternalSentinelStatus = {};
    let tilePending = false, tilePartial = false, retrying = false;
    const report = () => {
        if (!status.pending && !tilePending && !status.error && !tileFailed) retrying = false;
        onStatus({
            ...status,
            error: status.error === true || tileFailed,
            partial: tilePartial,
            captureError: status.error === true,
            pending: status.pending === true || tilePending,
            capturePending: status.pending === true,
            retry: status.retry === true || tileFailed || retrying,
            message: status.pending || status.error ? status.message
                : tileFailed ? tilePartial ? 'Some imagery couldn’t load. Available imagery is shown.'
                    : 'Imagery couldn’t load. Retry this capture.'
                    : tilePending ? 'Loading imagery' : status.message,
        });
    };
    const publish = (patch: Partial<InternalSentinelStatus>) => { status = { ...status, ...patch }; report(); };
    const cancel = () => {
        revision++;
        controller?.abort();
        controller = null;
        if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    const clear = () => { rendered = ''; tileFailed = tilePartial = tilePending = false; clearScenes(); };
    const choose = (retry = false) => {
        const current = target ? captures.find(candidate => candidate.platform === target!.platform
            && candidate.orbit === target!.orbit && Math.abs(candidate.time - target!.time) <= 900000) : captures[0];
        const option = (capture: SentinelCapture | SentinelTarget, id: string, latest = false): SentinelCaptureOption =>
            sentinelCaptureChoice(capture, zone, id, latest);
        const choices: SentinelCaptureOption[] = [
            captures[0] ? option(captures[0], 'latest', true) : { id: 'latest', label: 'Latest capture' },
            ...captures.slice(1).map(capture => option(capture, capture.key)),
        ];
        if (target && !current) choices.push(option(target, 'missing'));
        if (current) {
            const key = JSON.stringify(current.scenes.map(scene => [scene.id, scene.bounds]).sort());
            if (key !== rendered) { tileFailed = tilePartial = false; replaceScenes(current.scenes); tilePending = true; rendered = key; }
            else if (retry && tileFailed) { tileFailed = tilePartial = false; tilePending = true; retryTiles(); }
        } else clear();
        publish({
            pending: false,
            error: false,
            retry: false,
            retryAt: 0,
            captures: choices,
            capture: target && current !== captures[0] ? current?.key || 'missing' : 'latest',
            message: current ? `Coverage ${Math.round(current.coverage * 100)}% · Clouds ${typeof current.cloud === 'number' && Number.isFinite(current.cloud) ? `${Math.round(current.cloud)}%` : 'unknown'}`
                : target ? 'This capture does not cover the view.' : 'No captures in the past 30 days.',
        });
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
            const failure = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; retryAt?: unknown; message?: unknown } : null;
            if (owner !== revision || !active || failure?.name === 'AbortError') return;
            if (!valid) clear();
            if (failure?.code === 'rate-limit') {
                const nextRetryAt = typeof failure.retryAt === 'number' && Number.isFinite(failure.retryAt) ? failure.retryAt : 0;
                retryAt = Math.max(retryAt, nextRetryAt || Date.now() + 300000);
            }
            const message = typeof failure?.message === 'string' ? failure.message.slice(0, 80) : 'Captures unavailable. Retry.';
            publish({
                pending: false,
                error: true,
                retry: true,
                retryAt,
                message: failure?.code === 'rate-limit' ? 'Satellite service is busy. Try again later.'
                    : !valid ? message : rendered ? 'Capture search failed. Previous imagery shown.' : 'Captures unavailable. Retry.',
            });
        } finally { if (owner === revision) controller = null; }
    };
    return {
        activate(capture?: unknown) {
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
        select(value: string) {
            if (!active) return;
            if (value === 'latest') target = null;
            else { const capture = captures.find(candidate => candidate.key === value); if (!capture) return; target = sentinelTarget(capture); }
            onCapture(target); if (catalogValid) choose(); else void load();
        },
        retry() {
            if (!active || disposed || retryAt > Date.now()) return;
            retrying = true;
            if (catalogValid && rendered && tileFailed) {
                tileFailed = tilePartial = false; tilePending = true; report(); retryTiles();
            } else void load(true);
        },
        cooldown(value: number | undefined) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= Date.now() || value <= retryAt) return;
            retryAt = value; cancel();
            publish({ pending: false, error: true, retry: true, retryAt, message: 'Satellite service is busy. Try again later.' });
        },
        tileError(error: { code?: unknown; retryAt?: number | null } | null | undefined) {
            if (!active) return;
            tileFailed = true;
            tilePending = false;
            if (error?.code === 'rate-limit') {
                const nextRetryAt = typeof error.retryAt === 'number' && Number.isFinite(error.retryAt) ? error.retryAt : 0;
                retryAt = Math.max(retryAt, nextRetryAt || Date.now() + 300000);
                cancel();
                status.pending = false;
            }
            publish({ retryAt });
        },
        tileActivity(activity: SentinelTileActivity) {
            if (!active) return;
            tilePending = activity.pending === true;
            if (activity.error || activity.complete) { tileFailed = activity.error === true; tilePartial = activity.partial === true; }
            report();
        },
        dispose() { disposed = true; active = false; cancel(); clear(); },
    };
}
