// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies the extension-panel theme before its stylesheet can paint. Extension
// storage is asynchronous, so a synchronous page-local mirror supplies the
// first frame and the authoritative synced setting reconciles it afterward.

import { settings as S } from '../settings/settings.ts';

const CACHE_KEY = 'bpbThemePref';
const root = document.documentElement;

let revision = 0;
let cached: string | null = null;
try { cached = localStorage.getItem(CACHE_KEY); } catch { /* storage blocked */ }
let preference = S.clean({ theme: cached }).theme;

const paint = ({ cache = true }: { cache?: boolean } = {}) => {
    root.setAttribute('data-bpb-theme', S.resolveTheme(preference));
    if (!cache) return;
    try { localStorage.setItem(CACHE_KEY, preference); } catch { /* storage blocked */ }
};

const apply = (next: unknown) => {
    revision++;
    preference = S.clean({ theme: next }).theme;
    paint();
};
paint({ cache: false });

// Popup pages have no later settings controller, so the shared head bootstrap
// owns reconciliation. The options controller also calls apply while painting
// its controls; the operation is intentionally idempotent.
S.subscribe((settings: typeof S.DEFAULTS) => apply(settings.theme));
const initialRevision = revision;
void S.requireCurrent().then(settings => {
    if (revision === initialRevision) apply(settings.theme);
}).catch(error => {
    console.warn('Better Peakbagger: panel theme reconciliation failed', error);
});

if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (preference === 'system') paint(); };
    if (typeof mq?.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq?.addListener === 'function') mq.addListener(onChange);
}

export const panelTheme = { apply };
