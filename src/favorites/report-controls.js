// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
export const reportStyle = doc => {
    if (doc.getElementById('bpb-report-visibility-style')) return;
    const style = doc.createElement('style'); style.id = 'bpb-report-visibility-style';
    style.textContent = `
.bpb-report-tools { font:13px/1.4 Arial,sans-serif; color:#424b44; display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; margin:8px 0; max-width:100%; }
.bpb-report-tools button { min-height:32px; padding:5px 8px; border:0; border-radius:5px; background:transparent; color:#354c3c; font:inherit; cursor:pointer; }
.bpb-report-tools button:focus-visible { outline:2px solid #2f6b3f; outline-offset:2px; }
.bpb-report-tools button:disabled { cursor:wait; }
#bpb-ascent-report-tools button[aria-controls] { min-inline-size:9em; flex-shrink:0; white-space:nowrap; }
.bpb-report-tools .bpb-report-favorites { border:1px solid #9aa89e; background:#f6f8f6; }
.bpb-report-tools .bpb-report-favorites[aria-pressed="true"] { background:#e7f1e9; border-color:#2f6b3f; color:#245332; }
.bpb-report-status { color:#555e57; font-size:12px; }
.bpb-report-utilities { display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; }
.bpb-report-tools [hidden], .bpb-report-empty[hidden] { display:none; }
.bpb-report-empty { font:13px/1.5 Arial,sans-serif; padding:8px 0; }
.bpb-report-empty button { min-height:32px; }
html[data-bpb-theme="dark"] .bpb-report-tools { color:#cbd2cd; }
html[data-bpb-theme="dark"] .bpb-report-tools button { color:#a9d5b5; }
html[data-bpb-theme="dark"] .bpb-report-status { color:#c0c8c2; }
html[data-bpb-theme="dark"] .bpb-report-tools .bpb-report-favorites { background:#29322b; border-color:#71927a; }
html[data-bpb-theme="dark"] .bpb-report-tools .bpb-report-favorites[aria-pressed="true"] { background:#304a36; border-color:#8fc99c; color:#c8edd2; }
html[data-bpb-theme="dark"] .bpb-report-tools button:focus-visible { outline-color:#8fc99c; }
@media(max-width:600px) { .bpb-report-utilities { flex-basis:100%; } }
`;
    doc.head.append(style);
};
export const utilityButton = (doc, label, handler) => {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', handler); return button;
};
export const paintReveal = (button, status, counts, reveal, noun = 'reports') => {
    const n = counts.ignored.length;
    button.hidden = n === 0;
    button.setAttribute('aria-pressed', String(reveal));
    button.textContent = `${reveal ? 'Hide' : 'Show'} ignored · ${n}`;
    button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} ${n} ignored ${noun}`);
    status.hidden = n === 0;
    status.textContent = reveal ? '0 hidden by ignore' : counts.ignoredMatches === n ? ''
        : counts.ignoredMatches === 0 ? 'None match filters' : `${counts.ignoredMatches} matches filters`;
    button.setAttribute('aria-description', reveal ? `${n} ignored ${noun} included; 0 hidden by ignore.`
        : `${n} ${noun} hidden because you ignored their climbers; ${counts.ignoredMatches} matches current filters.`);
};
