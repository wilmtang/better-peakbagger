// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLayoutMenu } from './layout-menu.js';
import { mountPeakTableSplit } from './peak-table-split.js';
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
    mountPeakTableSplit(doc);
    const view = doc.defaultView, cards = new Map(), disposers = [];
    const make = (tag, className, text = '') => {
        const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
    };
    const help = make('span', 'bpb-peak-card-sr', 'Drag to move, or click for move options. Use arrow keys to change position or column; Home and End move within a column. Escape cancels a drag.');
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
    let anchor = null, drag = null, frame = null, scanning = false, suppressClick = false;
    const detailsAnchors = {};
    const columnOf = key => doc.getElementById('bpb-peak-table-split') ? preference.peakCardColumns[key] : 'map';
    const columnName = column => column === 'map' ? 'right column' : `left column, ${column === 'details' ? 'above' : 'below'} peak details`;
    const nativeDetails = () => doc.querySelector('#bpb-peak-details-column > .bpb-peak-native-table');
    const anchors = () => {
        const details = doc.getElementById('bpb-peak-details-column');
        if (details) for (const column of ['details', 'details-bottom']) if (!detailsAnchors[column]) {
            const table = doc.createElement('table'); table.id = `bpb-peak-${column}-cards`;
            table.className = 'bpb-peak-details-cards'; table.setAttribute('role', 'presentation');
            const body = doc.createElement('tbody'); detailsAnchors[column] = doc.createComment('Better Peakbagger left cards');
            body.append(detailsAnchors[column]); table.append(body);
            if (column === 'details') details.prepend(table); else details.append(table);
        }
        return { ...detailsAnchors, map: anchor };
    };
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
        const previous = { ...anchors() };
        for (const key of preference.peakCardOrder) {
            const item = cards.get(key), column = columnOf(key);
            if (!item || !previous[column]) continue;
            if (previous[column].nextSibling !== item.row) previous[column].after(item.row);
            previous[column] = item.row;
        }
        // A destination can have been hidden while empty. Reveal it before
        // restoring focus or scrolling to the moved card, not on a later scan.
        for (const column of ['details', 'details-bottom']) {
            const host = doc.getElementById(`bpb-peak-${column}-cards`);
            if (host && host.hidden !== (inColumn(column).length === 0)) host.hidden = inColumn(column).length === 0;
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
    const inColumn = column => visible().filter(item => columnOf(item.key) === column);
    const move = (item, index, column = columnOf(item.key)) => {
        if (!anchors()[column]) return;
        const list = inColumn(column), from = list.indexOf(item), others = list.filter(card => card !== item);
        if (index < 0 || index > others.length || from === index) return;
        let order;
        if (columnOf(item.key) === column) {
            const next = [...others]; next.splice(index, 0, item);
            const ids = next.map(card => card.key), present = new Set(ids);
            order = preference.peakCardOrder.map(key => present.has(key) ? ids.shift() : key);
        } else {
            order = preference.peakCardOrder.filter(key => key !== item.key);
            const before = others[index]?.key, after = others.at(-1)?.key;
            const at = before ? order.indexOf(before) : after ? order.indexOf(after) + 1 : order.length;
            order.splice(at, 0, item.key);
        }
        save({ peakCardOrder: order, peakCardColumns: { ...preference.peakCardColumns, [item.key]: column } });
        applyOrder(); focus(item);
        item.handle.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        announce(`${item.definition.name} moved to position ${index + 1} in the ${columnName(column)}.`);
    };
    const verticalTarget = (item, direction) => {
        const column = columnOf(item.key), list = inColumn(column), index = list.indexOf(item) + direction;
        if (column === 'details' && index === list.length) return { column: 'details-bottom', index: 0 };
        if (column === 'details-bottom' && index < 0) return { column: 'details', index: inColumn('details').length };
        return { column, index };
    };
    const stopFrame = () => { if (frame !== null) view.cancelAnimationFrame(frame); frame = null; };
    const cancel = () => {
        stopFrame();
        for (const item of cards.values()) item.menu?.close();
        if (!drag) return;
        const current = drag; drag = null;
        if (current.active) suppressClick = true;
        ghost.hidden = indicator.hidden = true;
        current.item.card.removeAttribute('data-bpb-card-lifted');
        doc.documentElement.classList.remove('bpb-peak-card-dragging');
        try { current.item.handle.releasePointerCapture?.(current.pointerId); } catch { /* capture already ended */ }
    };
    const locate = () => {
        if (!drag?.active) return;
        const split = doc.getElementById('bpb-peak-table-split');
        let column = 'map', area = drag.item.row.getBoundingClientRect();
        if (split) {
            column = ['details', 'map'].find(id => {
                const rect = doc.getElementById(`bpb-peak-${id}-column`).getBoundingClientRect();
                return drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top
                    && drag.y <= (view.getComputedStyle(split).display === 'grid' ? split.getBoundingClientRect().bottom : rect.bottom);
            });
            if (column) area = doc.getElementById(`bpb-peak-${column}-column`).getBoundingClientRect();
        }
        if (!column || drag.x < area.left - 24 || drag.x > area.right + 24) { indicator.hidden = true; drag.target = null; return; }
        if (column === 'details') {
            const native = nativeDetails().getBoundingClientRect();
            if (drag.y > native.top + native.height / 2) {
                column = 'details-bottom'; area = { left: area.left, width: area.width, top: native.bottom };
            }
        }
        const list = inColumn(column).filter(item => item !== drag.item);
        const index = list.filter(item => { const r = item.card.getBoundingClientRect(); return drag.y > r.top + r.height / 2; }).length;
        drag.target = { index, column };
        const target = list[index] || list.at(-1), bounds = target?.card.getBoundingClientRect() || area;
        const y = Math.max(8, Math.min(view.innerHeight - 8, target ? (list[index] ? bounds.top : bounds.bottom) : bounds.top));
        ghost.textContent = `${drag.item.definition.name} · ${columnName(column)}`;
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
        if (current.active) suppressClick = true;
        if (current.active && current.target !== null) move(current.item, current.target.index, current.target.column);
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
        handle.title = 'Drag to move · Click for options · Arrow keys to move';
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Home End'); handle.append(make('span', 'bpb-peak-card-dots'));
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
            heading.remove(); toolbar.append(...header.children);
            if (toolbar.childElementCount) body.append(toolbar);
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
            if (lifecycle.state !== 'active' || drag || (visible().length < 2 && !doc.getElementById('bpb-peak-table-split')) || event.button !== 0 || event.isPrimary === false) return;
            if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
            menu.close(); suppressClick = false; focus(item);
            drag = { item, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null };
            try { handle.setPointerCapture?.(event.pointerId); } catch { /* Window listeners finish the gesture. */ }
        };
        const menu = createLayoutMenu({ handle, label: `Move ${definition.name}`, actions: () => {
            const column = columnOf(key), list = inColumn(column), index = list.indexOf(item), other = column === 'map' ? 'details' : 'map';
            const up = verticalTarget(item, -1), downward = verticalTarget(item, 1);
            const placement = column === 'details-bottom' ? 'details' : 'details-bottom';
            return [
                { label: 'Move up', disabled: up.column === column && index <= 0, run: () => move(item, up.index, up.column) },
                { label: 'Move down', disabled: downward.column === column && index >= list.length - 1, run: () => move(item, downward.index, downward.column) },
                { label: `Move ${placement === 'details' ? 'above' : 'below'} peak details`, disabled: !anchors()[placement],
                    run: () => move(item, inColumn(placement).length, placement) },
                { label: `Move to ${other === 'details' ? 'left' : 'right'} column`, disabled: !anchors()[other], run: () => move(item, inColumn(other).length, other) },
            ];
        } });
        item.menu = menu;
        const click = event => {
            if (drag) return;
            if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
            suppressClick = false; menu.toggle();
        };
        const keydown = event => {
            if (drag || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const column = columnOf(key), list = inColumn(column);
            const other = event.key === 'ArrowLeft' ? 'details' : event.key === 'ArrowRight' ? 'map' : null;
            if (other) { event.preventDefault(); if ((other === 'map') !== (column === 'map')) move(item, inColumn(other).length, other); return; }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const target = verticalTarget(item, event.key === 'ArrowUp' ? -1 : 1);
                move(item, target.index, target.column); return;
            }
            if (column !== 'map' && (event.key === 'Home' || event.key === 'End')) {
                event.preventDefault();
                const target = event.key === 'Home' ? 'details' : 'details-bottom';
                move(item, event.key === 'Home' ? 0 : inColumn(target).filter(entry => entry !== item).length, target); return;
            }
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : null;
            if (index === null) return;
            event.preventDefault(); move(item, index);
        };
        toggle.addEventListener('click', collapse, key === 'sun'); handle.addEventListener('pointerdown', down);
        card.addEventListener('bpb:reveal-card', reveal);
        handle.addEventListener('click', click);
        handle.addEventListener('keydown', keydown); handle.addEventListener('lostpointercapture', pointerCancel);
        disposers.push(() => {
            menu.dispose(); handle.removeEventListener('click', click);
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
            for (const item of cards.values()) {
                applyCollapse(item);
                const hidden = (!doc.getElementById('bpb-peak-table-split') && visible().length < 2) || item.card.hidden || item.row.hidden;
                if (item.handle.hidden !== hidden) item.handle.hidden = hidden;
            }
            applyOrder();
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
            || JSON.stringify(preference.peakCardColumns) !== JSON.stringify(cleaned.peakCardColumns)
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
