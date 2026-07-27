// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One identity owner for Peakbagger's replaceable MasterMap iframe. Consumers
// subscribe to insertion, replacement, and load through this module instead of
// keeping their own cached element or MutationObserver.

export const createMapFrameLifecycle = ({
    selector,
    document: ownerDocument = globalThis.document,
    MutationObserver: Observer = globalThis.MutationObserver,
} = {}) => {
    let frame = null;
    let observer = null;
    let started = false;
    const subscribers = new Set();

    const query = () => {
        try {
            return ownerDocument?.querySelector(selector) || null;
        } catch {
            return null;
        }
    };
    const publish = detail => {
        subscribers.forEach(subscriber => {
            try { subscriber(detail); } catch (error) {
                console.error('Better Peakbagger: map-frame subscriber failed', error);
            }
        });
    };
    const handleLoad = () => publish({ frame, previous: frame, reason: 'load' });
    const refresh = () => {
        if (ownerDocument && ownerDocument.defaultView?.document !== ownerDocument) {
            observer?.disconnect();
            observer = null;
            return null;
        }
        const next = query();
        if (next === frame) return frame;
        const previous = frame;
        if (previous) previous.removeEventListener('load', handleLoad);
        frame = next;
        if (frame) frame.addEventListener('load', handleLoad);
        publish({ frame, previous, reason: 'identity' });
        return frame;
    };
    const start = () => {
        if (started) return;
        started = true;
        refresh();
        const root = ownerDocument?.body || ownerDocument?.documentElement;
        if (root && typeof Observer === 'function') {
            observer = new Observer(refresh);
            observer.observe(root, { childList: true, subtree: true });
        }
    };
    const dispose = () => {
        observer?.disconnect();
        observer = null;
        if (frame) frame.removeEventListener('load', handleLoad);
        frame = null;
        started = false;
        subscribers.clear();
    };

    return {
        current: () => frame || (!started ? query() : null),
        refresh,
        start,
        dispose,
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
    };
};

export const mapFrameLifecycle = { create: createMapFrameLifecycle };
