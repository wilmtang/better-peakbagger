// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// A deadline for work that needs the page's animation clock. A hidden tab stops
// that clock, so a healthy load would otherwise look like a failure when the user
// comes back. Becoming visible re-arms the whole duration rather than the
// remainder: nested deadlines keep their order only if each restarts in full.
export interface VisibleDeadline { clear(): void; }
export function createVisibleDeadline(owner: Document, delayMs: number, onExpire: () => void): VisibleDeadline {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const clear = () => { cancel(); owner.removeEventListener('visibilitychange', sync); };
    function sync() {
        cancel();
        if (owner.visibilityState !== 'hidden') timer = setTimeout(() => { clear(); onExpire(); }, delayMs);
    }
    owner.addEventListener('visibilitychange', sync);
    sync();
    return { clear };
}
