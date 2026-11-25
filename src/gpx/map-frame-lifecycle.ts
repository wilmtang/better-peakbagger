// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One identity owner for Peakbagger's replaceable MasterMap iframe. Consumers
// subscribe to insertion, replacement, and load through this module instead of
// keeping their own cached element or MutationObserver.

export interface MapFrameChangeDetail {
    frame: HTMLIFrameElement | null;
    previous: HTMLIFrameElement | null;
    reason: 'load' | 'identity';
}

export type MapFrameSubscriber = (detail: MapFrameChangeDetail) => void;

export interface MapFrameLifecycleOptions {
    selector?: string;
    document?: Document | null;
    MutationObserver?: typeof globalThis.MutationObserver | null;
}

export interface MapFrameLifecycle {
    current(): HTMLIFrameElement | null;
    refresh(): HTMLIFrameElement | null;
    start(): void;
    dispose(): void;
    subscribe(subscriber: MapFrameSubscriber): () => boolean;
}

export const createMapFrameLifecycle = ({
    selector,
    document: ownerDocument = globalThis.document,
    MutationObserver: Observer = globalThis.MutationObserver,
}: MapFrameLifecycleOptions = {}): MapFrameLifecycle => {
    let frame: HTMLIFrameElement | null = null;
    let observer: MutationObserver | null = null;
    let started = false;
    const subscribers = new Set<MapFrameSubscriber>();

    const query = (): HTMLIFrameElement | null => {
        try {
            return ownerDocument?.querySelector<HTMLIFrameElement>(selector!) || null;
        } catch {
            return null;
        }
    };
    const publish = (detail: MapFrameChangeDetail) => {
        subscribers.forEach(subscriber => {
            try { subscriber(detail); } catch (error) {
                console.error('Better Peakbagger: map-frame subscriber failed', error);
            }
        });
    };
    const handleLoad = () => publish({ frame, previous: frame, reason: 'load' });
    const refresh = (): HTMLIFrameElement | null => {
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
        subscribe(subscriber: MapFrameSubscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
    };
};

export const mapFrameLifecycle = { create: createMapFrameLifecycle };
