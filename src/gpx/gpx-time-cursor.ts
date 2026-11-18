// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A local presentation channel between MAIN-world GPX interaction and the
// isolated weather graph. No track objects, coordinates or privileged actions.
export const GPX_TIME_CURSOR = 'bpb:gpx-time-cursor';
export const GPX_TIME_CURSOR_REQUEST = 'bpb:gpx-time-cursor-request';

export interface GpxTimeCursorPoint {
    readonly timeState?: string;
    readonly ms?: number | null;
}

export interface GpxTimeCursorQuality {
    readonly hasProgress?: boolean;
}

export interface GpxTimeCursorState {
    hovering: boolean;
    hoverTime: number | null;
    selected: boolean;
    selectionTime: number | null;
}

export interface GpxTimeCursorPublisher {
    hover: (point?: GpxTimeCursorPoint | null, quality?: GpxTimeCursorQuality | null) => void;
    select: (point?: GpxTimeCursorPoint | null, quality?: GpxTimeCursorQuality | null) => void;
    suspend: () => void;
    resume: () => void;
    dispose: () => void;
}

interface GpxTimeCursorMessage extends GpxTimeCursorState {
    type: typeof GPX_TIME_CURSOR;
}

const validTime = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime());

const ownMessage = (event: MessageEvent<unknown>, ownerWindow: Window): boolean =>
    event.source === ownerWindow && event.origin === ownerWindow.location.origin;

const exactKeys = <K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const gpxCursorTime = (
    point?: GpxTimeCursorPoint | null,
    quality?: GpxTimeCursorQuality | null,
): number | null => point?.timeState === 'valid'
    && quality?.hasProgress === true && validTime(point.ms) ? point.ms : null;

export const readGpxTimeCursor = (
    event: MessageEvent<unknown>,
    ownerWindow: Window = window,
): GpxTimeCursorState | null => {
    const value: unknown = event.data;
    if (!ownMessage(event, ownerWindow)
        || !exactKeys(value, ['type', 'hovering', 'hoverTime', 'selected', 'selectionTime'])
        || value.type !== GPX_TIME_CURSOR || typeof value.hovering !== 'boolean' || typeof value.selected !== 'boolean'
        || !(value.hoverTime === null || validTime(value.hoverTime))
        || !(value.selectionTime === null || validTime(value.selectionTime))
        || (!value.hovering && value.hoverTime !== null) || (!value.selected && value.selectionTime !== null)) return null;
    return { hovering: value.hovering, hoverTime: value.hoverTime, selected: value.selected, selectionTime: value.selectionTime };
};

export const createGpxTimeCursorPublisher = (ownerWindow: Window = window): GpxTimeCursorPublisher => {
    let state: GpxTimeCursorMessage = { type: GPX_TIME_CURSOR, hovering: false, hoverTime: null, selected: false, selectionTime: null };
    let frame: number | null = null;
    let active = true;
    let disposed = false;
    const cancelFrame = (): void => { if (frame !== null) ownerWindow.cancelAnimationFrame(frame); frame = null; };
    const schedule = (): void => {
        if (!active || disposed || frame !== null) return;
        frame = ownerWindow.requestAnimationFrame(() => {
            frame = null;
            if (active && !disposed) ownerWindow.postMessage({ ...state }, ownerWindow.location.origin);
        });
    };
    const update = (next: Partial<GpxTimeCursorState>): void => {
        const keys = Object.keys(next) as (keyof GpxTimeCursorState)[];
        if (disposed || keys.every(key => state[key] === next[key])) return;
        state = { ...state, ...next }; schedule();
    };
    const onRequest = (event: MessageEvent<unknown>): void => {
        const data: unknown = event.data;
        if (ownMessage(event, ownerWindow) && exactKeys(data, ['type']) && data.type === GPX_TIME_CURSOR_REQUEST) schedule();
    };
    ownerWindow.addEventListener('message', onRequest);
    schedule();
    return {
        hover: (point, quality) => update({ hovering: !!point, hoverTime: gpxCursorTime(point, quality) }),
        select: (point, quality) => update({ hovering: false, hoverTime: null, selected: !!point, selectionTime: gpxCursorTime(point, quality) }),
        suspend: () => { active = false; cancelFrame(); state = { ...state, hovering: false, hoverTime: null }; },
        resume: () => { if (!disposed) { active = true; schedule(); } },
        dispose: () => { disposed = true; active = false; cancelFrame(); ownerWindow.removeEventListener('message', onRequest); },
    };
};
