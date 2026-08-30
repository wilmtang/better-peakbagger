// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A pagehide event is not necessarily teardown: persisted documents are being
// frozen for the back/forward cache and will receive pageshow when restored.
// This owner gives page surfaces one idempotent suspend/resume/dispose state
// machine instead of letting each listener interpret that distinction itself.

export const createPageLifecycle = ({
    ownerWindow = globalThis.window,
    onSuspend = () => {},
    onResume = () => {},
    onDispose = () => {},
} = {}) => {
    let state = 'active';
    const invoke = (callback, event, phase) => {
        try { callback(event); } catch (error) {
            console.error(`Better Peakbagger: page lifecycle ${phase} failed`, error);
        }
    };

    const handlePageHide = event => {
        if (state === 'disposed') return;
        if (event?.persisted === true) {
            if (state === 'suspended') return;
            state = 'suspended';
            invoke(onSuspend, event, 'suspend');
            return;
        }
        state = 'disposed';
        ownerWindow?.removeEventListener('pagehide', handlePageHide);
        ownerWindow?.removeEventListener('pageshow', handlePageShow);
        invoke(onDispose, event, 'dispose');
    };

    const handlePageShow = event => {
        if (state !== 'suspended' || event?.persisted !== true) return;
        state = 'active';
        invoke(onResume, event, 'resume');
    };

    ownerWindow?.addEventListener('pagehide', handlePageHide);
    ownerWindow?.addEventListener('pageshow', handlePageShow);

    const dispose = () => handlePageHide({ persisted: false });

    return Object.freeze({
        dispose,
        get state() { return state; },
    });
};

export const pageLifecycle = Object.freeze({ create: createPageLifecycle });
