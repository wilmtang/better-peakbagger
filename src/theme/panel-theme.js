// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies the extension-panel theme before its stylesheet can paint. Extension
// storage is asynchronous, so a synchronous page-local mirror supplies the
// first frame and the authoritative synced setting reconciles it afterward.

import { settings as S } from '../settings/settings.js';

const CACHE_KEY = 'bpbThemePref';
const root = document.documentElement;

let revision = 0;
let cached = null;
try { cached = localStorage.getItem(CACHE_KEY); } catch (e) { /* storage blocked */ }
let preference = S.clean({ theme: cached }).theme;

const paint = ({ cache = true } = {}) => {
    root.setAttribute('data-bpb-theme', S.resolveTheme(preference));
    if (!cache) return;
    try { localStorage.setItem(CACHE_KEY, preference); } catch (e) { /* storage blocked */ }
};

const apply = next => {
    revision++;
    preference = S.clean({ theme: next }).theme;
    paint();
};
paint({ cache: false });

// Popup pages have no later settings controller, so the shared head bootstrap
// owns reconciliation. The options controller also calls apply while painting
// its controls; the operation is intentionally idempotent.
S.subscribe(settings => apply(settings.theme));
const initialRevision = revision;
void S.requireCurrent().then(settings => {
    if (revision === initialRevision) apply(settings.theme);
}).catch(error => {
    console.warn('Better Peakbagger: panel theme reconciliation failed', error);
});

if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (preference === 'system') paint(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
}

export const panelTheme = { apply };
