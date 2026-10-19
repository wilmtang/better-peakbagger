// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createPageLifecycle } from './page-lifecycle.js';

// Only standalone extension cards participate. Native map, legend, links and
// peak details keep their DOM and owning execution context.
const definitions = {
    sun: { selector: '.bpb-sun-calculator--peak', name: 'Sun & Moon', collapsed: 'peakSunCollapsed' },
    weather: { selector: '#bpb-peak-weather', name: 'Summit weather', collapsed: 'peakWeatherCollapsed' },
    snow: { selector: '#bpb-peak-snow', name: 'Nearby snow', collapsed: 'peakSnowCollapsed' },
};

export function createPeakCardLayout({ document: doc, settings }) {
    if (doc.getElementById('bpb-peak-card-help')) return null;
    const view = doc.defaultView, cards = new Map(), disposers = [];
    const make = (tag, className, text = '') => {
        const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
    };
    const help = make('span', 'bpb-peak-card-sr', 'Drag to reorder, or use Up and Down, Home and End. Escape cancels a drag.');
    help.id = 'bpb-peak-card-help';
    const status = make('div', 'bpb-peak-card-status bpb-peak-card-sr'); status.setAttribute('role', 'status');
    const message = make('span', ''), dismiss = make('button', 'bpb-peak-card-dismiss', '×');
    dismiss.type = 'button'; dismiss.hidden = true; dismiss.setAttribute('aria-label', 'Dismiss card layout message');
    const dismissMessage = () => { status.classList.add('bpb-peak-card-sr'); dismiss.hidden = true; };
    dismiss.addEventListener('click', dismissMessage); status.append(message, dismiss);
    const ghost = make('div', 'bpb-peak-card-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.hidden = true;
    const indicator = make('div', 'bpb-peak-card-insertion'); indicator.setAttribute('aria-hidden', 'true'); indicator.hidden = true;
    doc.body.append(help, status, ghost, indicator);
    let preference = settings.clean(settings.DEFAULTS), received = false, revision = 0, writeRevision = 0;
    const pendingWrites = new Map(), failedFields = new Set();
    let anchor = null, drag = null, frame = null, scanning = false;
    const visible = () => preference.peakCardOrder.map(key => cards.get(key)).filter(item => item && !item.card.hidden && !item.row.hidden);
    const save = patch => {
        revision++;
        const ownWrite = ++writeRevision;
        for (const [key, value] of Object.entries(patch)) pendingWrites.set(key, { revision: ownWrite, value });
        preference = settings.clean({ ...preference, ...patch });
        const settle = failed => {
            if (lifecycle.state === 'disposed') return;
            for (const key of Object.keys(patch)) if (pendingWrites.get(key)?.revision === ownWrite) {
                pendingWrites.delete(key);
                if (failed) failedFields.add(key); else failedFields.delete(key);
            }
            if (failedFields.size) {
                message.textContent = 'Card layout could not be saved. Move or toggle the affected card again to retry.';
                dismiss.hidden = false;
                status.setAttribute('data-error', ''); status.classList.remove('bpb-peak-card-sr');
            } else { dismissMessage(); status.removeAttribute('data-error'); }
        };
        void settings.set(patch).then(() => settle(false)).catch(() => settle(true));
    };
    const announce = text => { if (!status.hasAttribute('data-error')) message.textContent = text; };
    const focus = item => item.handle.focus({ preventScroll: true });
    const applyOrder = () => {
        if (!anchor?.isConnected) return;
        const active = doc.activeElement;
        let previous = anchor;
        for (const key of preference.peakCardOrder) {
            const item = cards.get(key);
            if (!item) continue;
            if (previous.nextSibling !== item.row) previous.after(item.row);
            previous = item.row;
        }
        if (active?.isConnected && doc.activeElement !== active) active.focus({ preventScroll: true });
    };
    const applyCollapse = item => {
        const collapsed = preference[item.definition.collapsed];
        if (item.key === 'sun') {
            // The calculator keeps ownership of its own disclosure and render
            // lifecycle. Use its native toggle once it becomes available.
            if (!item.pendingToggle && !item.toggle.disabled && item.toggle.getAttribute('aria-expanded') === String(collapsed)) {
                item.restoring = true;
                try { item.toggle.click(); } finally { item.restoring = false; }
            }
            if (item.row.hidden !== item.card.hidden) item.row.hidden = item.card.hidden;
        } else {
            if (item.toggle.getAttribute('aria-expanded') !== String(!collapsed)) item.toggle.setAttribute('aria-expanded', String(!collapsed));
            if (item.body.hidden !== collapsed) item.body.hidden = collapsed;
        }
        item.card.setAttribute('data-bpb-card-collapsed', String(collapsed));
    };
    const move = (item, index) => {
        const list = visible(), from = list.indexOf(item);
        if (from < 0 || index < 0 || index >= list.length || from === index) return;
        const next = list.filter(card => card !== item); next.splice(index, 0, item);
        const ids = next.map(card => card.key), present = new Set(ids);
        const order = preference.peakCardOrder.map(key => present.has(key) ? ids.shift() : key);
        save({ peakCardOrder: order }); applyOrder(); focus(item);
        item.handle.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        announce(`${item.definition.name} moved to position ${index + 1} of ${list.length}.`);
    };
    const stopFrame = () => { if (frame !== null) view.cancelAnimationFrame(frame); frame = null; };
    const cancel = () => {
        stopFrame();
        if (!drag) return;
        const current = drag; drag = null;
        ghost.hidden = indicator.hidden = true;
        current.item.card.removeAttribute('data-bpb-card-lifted');
        doc.documentElement.classList.remove('bpb-peak-card-dragging');
        try { current.item.handle.releasePointerCapture?.(current.pointerId); } catch { /* capture already ended */ }
    };
    const locate = () => {
        if (!drag?.active) return;
        const rect = drag.item.row.getBoundingClientRect();
        if (drag.x < rect.left - 24 || drag.x > rect.right + 24) { indicator.hidden = true; drag.target = null; return; }
        const list = visible().filter(item => item !== drag.item);
        const index = list.filter(item => { const r = item.card.getBoundingClientRect(); return drag.y > r.top + r.height / 2; }).length;
        drag.target = index;
        const target = list[index] || list.at(-1);
        if (!target) return;
        const bounds = target.card.getBoundingClientRect(), y = list[index] ? bounds.top : bounds.bottom;
        indicator.hidden = false;
        Object.assign(indicator.style, { left: `${bounds.left}px`, top: `${y}px`, width: `${bounds.width}px` });
    };
    const autoscroll = () => {
        frame = null;
        if (!drag?.active) return;
        const edge = 56, speed = drag.y < edge ? -Math.ceil((edge - drag.y) / 4)
            : drag.y > view.innerHeight - edge ? Math.ceil((drag.y - view.innerHeight + edge) / 4) : 0;
        if (speed) { view.scrollBy(0, Math.max(-18, Math.min(18, speed))); locate(); }
        frame = view.requestAnimationFrame(autoscroll);
    };
    const pointerMove = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX; drag.y = event.clientY;
        if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
        if (!drag.active) {
            drag.active = true; ghost.hidden = false; ghost.textContent = drag.item.definition.name;
            drag.item.card.setAttribute('data-bpb-card-lifted', '');
            doc.documentElement.classList.add('bpb-peak-card-dragging');
            frame = view.requestAnimationFrame(autoscroll);
        }
        if (event.cancelable) event.preventDefault();
        Object.assign(ghost.style, { left: `${Math.min(view.innerWidth - 180, Math.max(8, drag.x + 12))}px`, top: `${Math.max(8, drag.y - 20)}px` });
        locate();
    };
    const pointerUp = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const current = drag; current.x = event.clientX; current.y = event.clientY; locate(); cancel();
        if (current.active && current.target !== null) move(current.item, current.target);
    };
    const pointerCancel = event => { if (drag?.pointerId === event.pointerId) cancel(); };
    const escape = event => {
        if (event.key !== 'Escape' || !drag) return;
        event.preventDefault(); cancel(); announce('Card reordering canceled.');
    };
    const register = (key, card) => {
        const definition = definitions[key];
        let row = key === 'sun' ? null : card.closest('tr');
        const mapRow = doc.getElementById('Gmap')?.closest('tr');
        const parent = row?.parentNode || mapRow?.parentNode || cards.values().next().value?.row.parentNode;
        if (!parent || parent.nodeName !== 'TBODY') return;
        if (!anchor) {
            anchor = doc.createComment('Better Peakbagger cards');
            if (mapRow?.parentNode === parent) mapRow.after(anchor); else parent.insertBefore(anchor, row);
        }
        if (key === 'sun') {
            card.id = 'bpb-peak-sun';
            row = doc.createElement('tr'); row.id = 'bpb-peak-sun-row';
            const cell = doc.createElement('td'); cell.colSpan = 2; cell.className = 'bpb-peak-card-cell'; cell.append(card); row.append(cell);
            anchor.after(row);
        }
        if (row.parentNode !== anchor.parentNode) return;
        const handle = make('button', 'bpb-peak-card-grip'); handle.type = 'button';
        handle.setAttribute('aria-label', `Reorder ${definition.name}`); handle.setAttribute('aria-describedby', help.id);
        handle.title = 'Drag to reorder · ↑ / ↓ to move'; handle.append(make('span', 'bpb-peak-card-dots'));
        let header, toggle, body;
        if (key === 'sun') {
            toggle = card.querySelector('.bpb-sun-calculator__toggle');
            header = make('div', 'bpb-peak-card-sun-header'); toggle.before(header); header.append(toggle, handle);
        } else {
            header = card.querySelector('header');
            const heading = header.querySelector('h2');
            toggle = make('button', 'bpb-peak-card-toggle'); toggle.type = 'button';
            const title = make('span', 'bpb-peak-card-title'); title.append(...heading.childNodes);
            const chevron = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            chevron.classList.add('bpb-peak-card-chevron'); chevron.setAttribute('viewBox', '0 0 16 16'); chevron.setAttribute('aria-hidden', 'true');
            const line = doc.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            line.setAttribute('points', '3 6 8 11 13 6'); chevron.append(line);
            toggle.append(title, chevron); heading.append(toggle);
            body = make('div', 'bpb-peak-card-body'); body.id = `bpb-peak-${key}-body`;
            toggle.setAttribute('aria-controls', body.id);
            // Keep the first row solely a disclosure, like Sun & Moon. Move
            // existing nodes so their owners retain listeners and live text.
            const toolbar = make('div', 'bpb-peak-card-toolbar');
            heading.remove(); toolbar.append(...header.children); body.append(toolbar);
            header.append(heading, handle);
            for (const child of [...card.children]) if (child !== header) body.append(child);
            card.append(body);
        }
        header.classList.add('bpb-peak-card-header');
        const item = { key, card, row, header, handle, toggle, body, definition, restoring: false, pendingToggle: false, toggleTimer: null };
        cards.set(key, item); card.setAttribute('data-bpb-peak-card', key);
        const collapse = () => {
            if (item.restoring || toggle.disabled) return;
            if (key === 'sun') {
                // Firefox may dispatch isolated listeners before MAIN-world
                // listeners. Capture intent first, then read the calculator's
                // final disclosure on the next task; observers must not undo
                // its native click while that event is still being handled.
                item.pendingToggle = true; view.clearTimeout(item.toggleTimer);
                item.toggleTimer = view.setTimeout(() => {
                    item.pendingToggle = false; item.toggleTimer = null;
                    if (lifecycle.state === 'disposed') return;
                    save({ [definition.collapsed]: toggle.getAttribute('aria-expanded') !== 'true' }); applyCollapse(item);
                }, 0);
            } else {
                save({ [definition.collapsed]: !preference[definition.collapsed] }); applyCollapse(item);
            }
        };
        const reveal = () => {
            if (!preference[definition.collapsed] || lifecycle.state !== 'active') return;
            save({ [definition.collapsed]: false }); applyCollapse(item);
        };
        const down = event => {
            if (lifecycle.state !== 'active' || drag || visible().length < 2 || event.button !== 0 || event.isPrimary === false) return;
            if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
            focus(item);
            drag = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null };
            try { handle.setPointerCapture?.(event.pointerId); } catch { /* Window listeners finish the gesture. */ }
        };
        const keydown = event => {
            if (drag || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const list = visible(), from = list.indexOf(item);
            const index = event.key === 'ArrowUp' ? from - 1 : event.key === 'ArrowDown' ? from + 1
                : event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null;
            if (index === null) return;
            event.preventDefault(); move(item, index);
        };
        toggle.addEventListener('click', collapse, key === 'sun'); handle.addEventListener('pointerdown', down);
        card.addEventListener('bpb:reveal-card', reveal);
        handle.addEventListener('keydown', keydown); handle.addEventListener('lostpointercapture', pointerCancel);
        disposers.push(() => {
            view.clearTimeout(item.toggleTimer);
            toggle.removeEventListener('click', collapse, key === 'sun'); handle.removeEventListener('pointerdown', down);
            card.removeEventListener('bpb:reveal-card', reveal);
            handle.removeEventListener('keydown', keydown); handle.removeEventListener('lostpointercapture', pointerCancel);
        });
    };
    const scan = () => {
        if (scanning || lifecycle.state !== 'active') return;
        scanning = true;
        try {
            for (const [key, item] of cards) if (!item.card.isConnected) {
                if (drag?.item === item) cancel();
                if (key === 'sun') item.row.remove();
                cards.delete(key);
            }
            for (const key of settings.DEFAULTS.peakCardOrder) {
                const card = doc.querySelector(definitions[key].selector);
                if (card && !cards.has(key)) register(key, card);
            }
            applyOrder();
            for (const item of cards.values()) {
                applyCollapse(item);
                const hidden = visible().length < 2 || item.card.hidden || item.row.hidden;
                if (item.handle.hidden !== hidden) item.handle.hidden = hidden;
            }
            if (drag && !visible().includes(drag.item)) cancel();
        } finally { scanning = false; }
    };
    const observer = new view.MutationObserver(scan);
    const observe = () => observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-expanded'] });
    const applyPreference = next => {
        if (lifecycle.state === 'disposed') return;
        received = true; revision++;
        const cleaned = settings.clean(next);
        // Storage can publish an earlier queued click while a newer click is
        // still being saved. Keep the newest intent for each independent field.
        for (const [key, pending] of pendingWrites) cleaned[key] = pending.value;
        if (preference.peakCardOrder.join() !== cleaned.peakCardOrder.join()
            || Object.values(definitions).some(definition => preference[definition.collapsed] !== cleaned[definition.collapsed])) cancel();
        preference = cleaned; scan();
    };
    const unsubscribe = settings.subscribe(applyPreference);
    const lifecycle = createPageLifecycle({ ownerWindow: view, onSuspend: () => { cancel(); observer.disconnect(); },
        onResume: () => { observe(); scan(); },
        onDispose: () => {
            cancel(); observer.disconnect(); unsubscribe(); disposers.forEach(dispose => dispose());
            view.removeEventListener('pointermove', pointerMove, true); view.removeEventListener('pointerup', pointerUp, true);
            view.removeEventListener('pointercancel', pointerCancel, true); view.removeEventListener('keydown', escape, true);
            view.removeEventListener('blur', cancel); view.removeEventListener('resize', cancel);
            dismiss.removeEventListener('click', dismissMessage);
            help.remove(); status.remove(); ghost.remove(); indicator.remove();
        },
    });
    view.addEventListener('pointermove', pointerMove, { capture: true, passive: false }); view.addEventListener('pointerup', pointerUp, true);
    view.addEventListener('pointercancel', pointerCancel, true); view.addEventListener('keydown', escape, true);
    view.addEventListener('blur', cancel); view.addEventListener('resize', cancel);
    observe(); scan();
    const initialRevision = revision;
    void settings.requireCurrent().then(next => { if (!received && revision === initialRevision) applyPreference(next); }).catch(() => {});
    return { lifecycle };
}
