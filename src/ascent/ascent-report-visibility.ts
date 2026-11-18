// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { observeIgnored, type IgnoredStorageApi, type ObservedIgnoredState } from '../favorites/ignored-client.ts';
import { ascentReport } from '../favorites/report-adapters.ts';
import { reportStyle, utilityButton } from '../favorites/report-controls.ts';

interface SavedFrameAttributes {
    src: string | null;
    srcdoc: string | null;
}

let state: ObservedIgnoredState = { list: null, error: '' };
let render: () => void = () => {};
let startupRow: HTMLTableRowElement | null = null;
let originalVisibility = '';
const observer = observeIgnored(chrome as unknown as IgnoredStorageApi, next => { state = next; render(); });
const restoreStartup = (): void => {
    if (startupRow) startupRow.style.visibility = originalVisibility;
    startupRow = null;
};
const scan = (): void => {
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
const mount = (): void => {
    startup.disconnect();
    const target = ascentReport(document);
    if (!target) { restoreStartup(); clearTimeout(recovery); observer.stop(); return; }
    reportStyle(document);
    const { row, cell, cid, heading } = target;
    const display = row.style.display;
    const headingAnchor = document.createComment('bpb-ascent-report-heading'); heading.before(headingAnchor);
    if (!cell.id) cell.id = 'bpb-ascent-report-content';
    const controls = document.createElement('tr');
    const controlCell = document.createElement('td'); controlCell.colSpan = 2; controls.append(controlCell); row.before(controls);
    const tools = document.createElement('div'); tools.className = 'bpb-report-tools'; tools.id = 'bpb-ascent-report-tools';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const frames = new Map<HTMLIFrameElement, SavedFrameAttributes>();
    let reveal = false, hidden = false;
    const suspendFrames = (): void => {
        for (const frame of cell.querySelectorAll('iframe')) {
            const saved = frames.get(frame);
            const src = frame.getAttribute('src'), srcdoc = frame.getAttribute('srcdoc');
            if (saved && src === 'about:blank' && srcdoc === null) continue;
            frames.set(frame, { src: saved && src === 'about:blank' ? saved.src : src,
                srcdoc: srcdoc ?? saved?.srcdoc ?? null });
            frame.removeAttribute('srcdoc'); frame.src = 'about:blank';
        }
    };
    const frameObserver = new MutationObserver(() => { if (hidden) suspendFrames(); });
    frameObserver.observe(cell, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc'] });
    cell.addEventListener('play', event => {
        const targetElement = event.target;
        if (hidden && targetElement && 'matches' in targetElement
            && typeof (targetElement as Element).matches === 'function'
            && (targetElement as Element).matches('video,audio')) {
            try { (targetElement as HTMLMediaElement).pause(); } catch { /* unsupported media */ }
        }
    }, true);
    const button = utilityButton(document, 'Show ignored · 1', () => { reveal = !reveal; render(); });
    button.setAttribute('aria-controls', cell.id);
    const retry = utilityButton(document, 'Retry', () => { void observer.refresh(); });
    tools.append(button, status, retry); controlCell.append(tools);
    render = () => {
        const ignored = !!state.list?.entries.some(entry => entry.cid === cid);
        const conceal = ignored && !reveal;
        if (conceal && cell.contains(document.activeElement)) button.focus({ preventScroll: true });
        if (conceal && !hidden) {
            for (const media of cell.querySelectorAll<HTMLMediaElement>('video,audio')) {
                if (!media.paused) { try { media.pause(); } catch { /* unsupported media */ } }
            }
            // Embedded players have no common pause API. Suspend their source
            // while concealed, retaining the same iframe node and original URL.
            suspendFrames();
        }
        if (!conceal && hidden) {
            for (const [frame, saved] of frames) {
                if (saved.src === null) frame.removeAttribute('src'); else frame.setAttribute('src', saved.src);
                if (saved.srcdoc === null) frame.removeAttribute('srcdoc'); else frame.setAttribute('srcdoc', saved.srcdoc);
            }
            frames.clear();
        }
        hidden = conceal; row.style.display = conceal ? 'none' : display;
        controls.hidden = !ignored && !state.error;
        // Keep the original heading above the control in both disclosure states.
        // Return it to the native report when there is no visibility control.
        if (controls.hidden) {
            if (heading.parentElement !== cell) headingAnchor.after(heading);
        } else if (heading.parentElement !== controlCell) controlCell.prepend(heading);
        status.textContent = state.error || 'Ignored climber';
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
