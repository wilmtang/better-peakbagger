// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A local presentation channel between MAIN-world GPX interaction and the
// isolated weather graph. No track objects, coordinates or privileged actions.
export const GPX_TIME_CURSOR = 'bpb:gpx-time-cursor';
export const GPX_TIME_CURSOR_REQUEST = 'bpb:gpx-time-cursor-request';
const validTime = value => Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const ownMessage = (event, ownerWindow) => event.source === ownerWindow && event.origin === ownerWindow.location.origin;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const gpxCursorTime = (point, quality) => point?.timeState === 'valid'
    && quality?.hasProgress === true && validTime(point.ms) ? point.ms : null;

export const readGpxTimeCursor = (event, ownerWindow = window) => {
    const value = event.data;
    if (!ownMessage(event, ownerWindow)
        || !exactKeys(value, ['type', 'hovering', 'hoverTime', 'selected', 'selectionTime'])
        || value.type !== GPX_TIME_CURSOR || typeof value.hovering !== 'boolean' || typeof value.selected !== 'boolean'
        || !(value.hoverTime === null || validTime(value.hoverTime))
        || !(value.selectionTime === null || validTime(value.selectionTime))
        || (!value.hovering && value.hoverTime !== null) || (!value.selected && value.selectionTime !== null)) return null;
    return { hovering: value.hovering, hoverTime: value.hoverTime, selected: value.selected, selectionTime: value.selectionTime };
};

export const createGpxTimeCursorPublisher = (ownerWindow = window) => {
    let state = { type: GPX_TIME_CURSOR, hovering: false, hoverTime: null, selected: false, selectionTime: null };
    let frame = null, active = true, disposed = false;
    const cancelFrame = () => { if (frame !== null) ownerWindow.cancelAnimationFrame(frame); frame = null; };
    const schedule = () => {
        if (!active || disposed || frame !== null) return;
        frame = ownerWindow.requestAnimationFrame(() => {
            frame = null;
            if (active && !disposed) ownerWindow.postMessage({ ...state }, ownerWindow.location.origin);
        });
    };
    const update = next => {
        if (disposed || Object.keys(next).every(key => state[key] === next[key])) return;
        state = { ...state, ...next }; schedule();
    };
    const onRequest = event => {
        if (ownMessage(event, ownerWindow) && exactKeys(event.data, ['type']) && event.data.type === GPX_TIME_CURSOR_REQUEST) schedule();
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
