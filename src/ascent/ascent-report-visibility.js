// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { observeIgnored } from '../favorites/ignored-client.js';
import { ascentReport } from '../favorites/report-adapters.js';
import { reportStyle, utilityButton } from '../favorites/report-controls.js';

let state = { list: null, error: '' }, render = () => {}, startupRow = null, originalVisibility = '';
const observer = observeIgnored(chrome, next => { state = next; render(); });
const restoreStartup = () => {
    if (startupRow) startupRow.style.visibility = originalVisibility;
    startupRow = null;
};
const scan = () => {
    if (startupRow || state.list || state.error) return;
    const target = ascentReport(document);
    if (target) { startupRow = target.row; originalVisibility = target.row.style.visibility; startupRow.style.visibility = 'hidden'; }
};
const startup = new MutationObserver(scan); startup.observe(document, { childList: true, subtree: true }); scan();
const recovery = setTimeout(() => {
    restoreStartup(); startup.disconnect();
    if (!state.list) state.error = "Couldn't load ignored climbers.";
    render();
}, 3000);
const mount = () => {
    startup.disconnect();
    const target = ascentReport(document);
    if (!target) { restoreStartup(); clearTimeout(recovery); observer.stop(); return; }
    reportStyle(document);
    const { row, cell, cid } = target;
    const display = row.style.display;
    if (!cell.id) cell.id = 'bpb-ascent-report-content';
    const controls = document.createElement('tr');
    const controlCell = document.createElement('td'); controlCell.colSpan = 2; controls.append(controlCell); row.before(controls);
    const title = document.createElement('h2'); title.textContent = 'Ascent Trip Report';
    const tools = document.createElement('div'); tools.className = 'bpb-report-tools'; tools.id = 'bpb-ascent-report-tools';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const frames = new Map();
    let reveal = false, hidden = false;
    const button = utilityButton(document, 'Show ignored · 1', () => { reveal = !reveal; render(); });
    button.setAttribute('aria-controls', cell.id);
    const retry = utilityButton(document, 'Retry', () => { void observer.refresh(); });
    tools.append(status, button, retry); controlCell.append(title, tools);
    render = () => {
        const ignored = !!state.list?.entries.some(entry => entry.cid === cid);
        const conceal = ignored && !reveal;
        if (conceal && cell.contains(document.activeElement)) button.focus({ preventScroll: true });
        if (conceal && !hidden) {
            for (const media of cell.querySelectorAll('video,audio')) {
                if (!media.paused) { try { media.pause(); } catch { /* unsupported media */ } }
            }
            // Embedded players have no common pause API. Suspend their source
            // while concealed, retaining the same iframe node and original URL.
            for (const frame of cell.querySelectorAll('iframe')) {
                frames.set(frame, frame.getAttribute('src')); frame.src = 'about:blank';
            }
        }
        if (!conceal && hidden) {
            for (const [frame, src] of frames) {
                if (src === null) frame.removeAttribute('src'); else frame.setAttribute('src', src);
            }
            frames.clear();
        }
        hidden = conceal; row.style.display = conceal ? 'none' : display;
        controls.hidden = !ignored && !state.error;
        title.hidden = !conceal;
        status.textContent = state.error || (conceal ? '1 report hidden · Ignored climber' : '0 hidden by ignore');
        button.hidden = !ignored;
        button.textContent = reveal ? 'Hide ignored · 1' : 'Show ignored · 1';
        button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} 1 ignored report`);
        button.setAttribute('aria-pressed', String(reveal));
        retry.hidden = !state.error;
        if (state.list || state.error) { restoreStartup(); clearTimeout(recovery); }
    };
    window.addEventListener('pageshow', event => { if (event.persisted) { reveal = false; render(); void observer.refresh(); } });
    render();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
