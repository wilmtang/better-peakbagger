// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registered only with optional Instagram access. Even then, inspect/change a
// document only after a configuration message from our actual packaged parent.
// No caption text, media URL, cookies or provider content crosses that boundary.
const NEXT='button[aria-label="Next"],button._afxw';
const BACK='button[aria-label="Go back"],button._afxv';
export function readInstagramCarousel(doc) {
    // Native viewport-unit slides can include the scrollbar gutter (Firefox).
    const viewports = [doc.documentElement.clientWidth, doc.defaultView.innerWidth].filter(width => width >= 150);
    if (!viewports.length) return null;
    const lists = [...doc.querySelectorAll('.Embed ul')].filter(list => list.children.length >= 2 && list.children.length <= 100
        && [...list.children].every(item => item.tagName === 'LI'));
    const matches = [];
    for (const list of lists) {
        const items = [...list.children], boxes = items.map(item => item.getBoundingClientRect()), width = boxes[0].width;
        const direction=boxes[1].x>boxes[0].x?1:-1;
        if (!viewports.some(viewport => Math.abs(width - viewport) <= 2) || !boxes.every((box, index) => Number.isFinite(box.x)
            && Math.abs(box.width - width) <= 1
            && Math.abs(box.x - boxes[0].x - index * width * direction) <= 2)) continue;
        const offset = -boxes[0].x / (width * direction), index = Math.round(offset);
        if (Math.abs(index - offset) > .02 || index < 0 || index > items.length) continue;
        matches.push({ list, items, index });
    }
    return matches.length === 1 ? matches[0] : null;
}

export function installInstagramDisplay(doc, extensionOrigin) {
    const win = doc.defaultView;
    if (win.parent === win || win.location.origin !== 'https://www.instagram.com'
        || !/^\/(?:p|reel)\/[A-Za-z0-9_-]{1,64}\/embed\/captioned\/$/.test(win.location.pathname)) return null;
    let enabled = false, pending = null, recovered = false;
    const marked = new Set();
    const clearMarks = () => { for (const node of marked) node.removeAttribute('data-bpb-instagram-end'); marked.clear(); };
    const refresh = () => {
        pending = null;
        if (!enabled) return;
        const state = readInstagramCarousel(doc);
        const next = doc.querySelector(`.Embed :is(${NEXT})`);
        const back = doc.querySelector(`.Embed :is(${BACK})`);
        const hide = new Set();
        if (state && state.index >= state.items.length - 1 && next) hide.add(next);
        if (state?.index === 0 && back) hide.add(back);
        for (const node of marked) if (!hide.has(node)) node.removeAttribute('data-bpb-instagram-end');
        marked.clear();
        for (const node of hide) {
            node.setAttribute('data-bpb-instagram-end', ''); marked.add(node);
            if (doc.activeElement === node) {
                const focus = state.items[state.index]?.querySelector('[aria-label="Control"]') || (node === next ? back : next);
                focus?.focus({ preventScroll: true });
            }
        }
        // Swipe/keyboard navigation can bypass the chevron's click handler.
        // Recover only the recognized one-slot overflow, once per overflow.
        if (state && state.index === state.items.length && !recovered && back) { recovered = true; back.click(); }
        else if (state && state.index < state.items.length) recovered = false;
    };
    const schedule = () => { if (enabled && pending === null) pending = win.requestAnimationFrame(refresh); };
    const observer = new win.MutationObserver(schedule);
    const disable = () => {
        enabled = false; observer.disconnect(); clearMarks();
        doc.documentElement.removeAttribute('data-bpb-instagram-theme');
        if (pending !== null) win.cancelAnimationFrame(pending);
        pending = null; recovered = false;
    };
    const receive = event => {
        if (event.source !== win.parent || event.origin !== extensionOrigin || event.data?.__bpbInstagramDisplay !== true) return;
        if (event.data.enabled !== true) { disable(); return; }
        if (!['light', 'dark'].includes(event.data.theme)) return;
        if (!enabled) { enabled = true; observer.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] }); }
        doc.documentElement.dataset.bpbInstagramTheme = event.data.theme;
        schedule();
    };
    const guard = event => {
        if (!enabled) return;
        const button = event.target.closest?.(`${NEXT},${BACK}`);
        if (!button?.closest('.Embed')) return;
        const state = readInstagramCarousel(doc);
        if (state && (button.matches(NEXT) ? state.index >= state.items.length - 1 : state.index === 0)) {
            event.preventDefault(); event.stopImmediatePropagation(); schedule();
        }
    };
    doc.addEventListener('click', guard, true);
    doc.addEventListener('transitionend', schedule, true);doc.addEventListener('animationend', schedule, true);
    win.addEventListener('message', receive); win.addEventListener('resize', schedule);
    const dispose = () => { disable(); doc.removeEventListener('click', guard, true);doc.removeEventListener('transitionend', schedule, true);doc.removeEventListener('animationend', schedule, true); win.removeEventListener('message', receive); win.removeEventListener('resize', schedule); };
    win.addEventListener('pagehide', dispose, { once: true });
    win.parent.postMessage({ __bpbInstagramProvider: 'ready' }, extensionOrigin);
    return { dispose };
}

if (typeof document !== 'undefined') {
    const api = globalThis.browser || globalThis.chrome;
    if (api?.runtime?.getURL) {
        const url = new URL(api.runtime.getURL(''));
        installInstagramDisplay(document, `${url.protocol}//${url.host}`);
    }
}
