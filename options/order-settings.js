// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { settingsSchema as Schema } from '../src/settings/settings-schema.js';

// Stable rows preserve label associations and focus while reordering. Only the
// grip starts a drag: using a provider checkbox never changes its position.
export const initOrderSettings = ({ save }) => {
    const labels = { gaia: 'Gaia GPS', onx: 'onX Backcountry', alltrails: 'AllTrails', caltopo: 'CalTopo',
        fav: 'Climbing buddies / favorites', gps: 'GPS track', tr: 'Trip report', link: 'Link', beta: 'Has beta' };
    const definitions = [
        ['map-provider-order', 'mapProviderOrder', Schema.MAP_PROVIDERS, 'mapProvidersEnabled'],
        ['beta-peak-order', 'betaPeakFilterOrder', Schema.PEAK_FILTER_ORDER],
        ['beta-personal-order', 'betaPersonalFilterOrder', Schema.PERSONAL_FILTER_ORDER],
    ];
    const lists = definitions.map(([id, key, defaults, enabledKey]) => {
        const list = document.getElementById(id);
        const instructions = document.createElement('span');
        instructions.id = `${id}-help`;
        instructions.className = 'order-settings-sr';
        instructions.textContent = 'Drag to reorder, or use the Up and Down arrow keys. Escape cancels a drag.';
        const status = document.createElement('span');
        status.className = 'order-settings-sr';
        status.setAttribute('role', 'status');
        list.after(instructions, status);
        const scroller = list.closest('.content');
        const rows = new Map();
        const animations = new Map();
        const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        let settings = Schema.clean();
        let pending = false;
        let drag = null;
        let scrollFrame = null;
        const order = () => settings[key] || defaults;
        const sameOrder = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
        const announce = (item, items) => { status.textContent = `${labels[item]} moved to position ${items.indexOf(item) + 1} of ${items.length}.`; };
        const animate = (row, from) => {
            animations.get(row)?.cancel();
            if (reducedMotion() || !row.animate || Math.abs(from) < 1) return;
            const animation = row.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
                { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
            animations.set(row, animation);
            const forget = () => { if (animations.get(row) === animation) animations.delete(row); };
            animation.addEventListener?.('finish', forget, { once: true });
            animation.addEventListener?.('cancel', forget, { once: true });
        };
        const render = (motion = false) => {
            const focused = list.contains(document.activeElement) ? document.activeElement : null;
            const before = motion ? new Map([...rows.values()].map(row => [row, row.getBoundingClientRect().top])) : null;
            for (const [index, item] of (drag?.draft || order()).entries()) {
                const row = rows.get(item);
                if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
                row.querySelector('.order-grip').disabled = pending;
                const check = row.querySelector('input');
                if (check) { check.checked = settings[enabledKey].includes(item); check.disabled = pending; }
                if (before && row !== drag?.row) animate(row, before.get(row) - (list.getBoundingClientRect().top + row.offsetTop));
            }
            if (focused && !focused.disabled) focused.focus({ preventScroll: true });
        };
        const change = async (patch, item) => {
            if (pending) return;
            const focus = list.contains(document.activeElement) ? document.activeElement : null;
            pending = true;
            settings = { ...settings, ...patch };
            render(true);
            try { settings = await save(patch); }
            catch { /* The parent restores confirmed settings and reports failure. */ }
            finally {
                pending = false;
                render();
                if (focus && (document.activeElement === document.body || document.activeElement === focus)) focus.focus({ preventScroll: true });
                if (item && sameOrder(order(), patch[key])) announce(item, order());
            }
        };
        const release = () => {
            const ended = drag;
            drag = null;
            if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
            list.removeAttribute('data-reordering');
            ended.row.removeAttribute('data-dragging');
            ended.row.style.removeProperty('transform');
            try { ended.handle.releasePointerCapture?.(ended.pointerId); } catch { /* Already released. */ }
            return ended;
        };
        const finish = cancelled => {
            if (!drag) return;
            const from = drag.row.getBoundingClientRect().top;
            const ended = release();
            if (!ended.started) return;
            if (cancelled) {
                render(true);
                status.textContent = 'Reordering canceled.';
            } else if (!sameOrder(ended.draft, order())) {
                void change({ [key]: ended.draft }, ended.item);
            }
            animate(ended.row, from - ended.row.getBoundingClientRect().top);
        };
        const move = clientY => {
            if (!drag?.started) return;
            const bounds = list.getBoundingClientRect();
            const top = Math.max(bounds.top, Math.min(bounds.bottom - drag.row.offsetHeight, clientY - drag.grabOffset));
            const center = top + drag.row.offsetHeight / 2;
            const others = drag.draft.filter(item => item !== drag.item);
            const index = others.filter(item => {
                const row = rows.get(item);
                return bounds.top + row.offsetTop + row.offsetHeight / 2 < center;
            }).length;
            others.splice(index, 0, drag.item);
            if (!sameOrder(others, drag.draft)) {
                drag.draft = others;
                render(true);
                if (!drag) return;
                // Moving the grip's ancestor can release capture in a browser.
                try { drag.handle.setPointerCapture?.(drag.pointerId); } catch { /* Window listeners remain active. */ }
            }
            drag.row.style.transform = `translateY(${top - (list.getBoundingClientRect().top + drag.row.offsetTop)}px)`;
        };
        const scroll = () => {
            scrollFrame = null;
            if (!drag?.started || !scroller) return;
            const bounds = scroller.getBoundingClientRect();
            const delta = drag.lastY < bounds.top + 40 ? -8 : drag.lastY > bounds.bottom - 40 ? 8 : 0;
            if (delta) { scroller.scrollTop += delta; move(drag.lastY); }
            scrollFrame = requestAnimationFrame(scroll);
        };
        for (const item of defaults) {
            const row = document.createElement('li');
            row.dataset.orderItem = item;
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'order-grip';
            handle.setAttribute('aria-label', `Reorder ${labels[item]}`);
            handle.setAttribute('aria-describedby', instructions.id);
            handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
            handle.title = 'Drag to reorder · ↑ / ↓';
            const dots = document.createElement('span');
            dots.className = 'order-grip-dots';
            dots.setAttribute('aria-hidden', 'true');
            handle.append(dots);
            handle.addEventListener('pointerdown', event => {
                if (pending || drag || event.isPrimary === false || event.button !== 0) return;
                handle.focus({ preventScroll: true });
                drag = { item, row, handle, pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY,
                    grabOffset: event.clientY - row.getBoundingClientRect().top, draft: [...order()], started: false };
                try { handle.setPointerCapture?.(event.pointerId); } catch { /* Unsupported in DOM fixtures. */ }
            });
            handle.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); finish(true); return; }
                const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                if (!delta || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                if (pending || drag) return;
                const next = [...order()];
                const from = next.indexOf(item), to = from + delta;
                if (to < 0 || to >= next.length) return;
                [next[from], next[to]] = [next[to], next[from]];
                void change({ [key]: next }, item);
            });
            row.append(handle);
            const label = document.createElement(enabledKey ? 'label' : 'span');
            label.className = 'order-setting-label';
            if (enabledKey) {
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.addEventListener('change', () => {
                    const enabled = settings[enabledKey].filter(value => value !== item);
                    if (check.checked) enabled.push(item);
                    void change({ [enabledKey]: enabled });
                });
                label.append(check);
            }
            label.append(document.createTextNode(labels[item]));
            row.append(label);
            rows.set(item, row);
        }
        window.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag.lastY = event.clientY;
            if (!drag.started && Math.abs(event.clientY - drag.startY) < 6) return;
            if (!drag.started) {
                drag.started = true;
                animations.get(drag.row)?.cancel();
                drag.row.setAttribute('data-dragging', '');
                list.setAttribute('data-reordering', '');
                scrollFrame = requestAnimationFrame(scroll);
            }
            event.preventDefault();
            move(event.clientY);
        }, { passive: false });
        window.addEventListener('pointerup', event => { if (event.pointerId === drag?.pointerId) finish(false); });
        window.addEventListener('pointercancel', event => { if (event.pointerId === drag?.pointerId) finish(true); });
        window.addEventListener('keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); finish(true); } });
        window.addEventListener('blur', event => {
            // Refocusing a moved grip can blur the document viewport without
            // leaving this window. Only an external focus change cancels.
            if (event.relatedTarget?.ownerDocument === document) return;
            finish(true);
        });
        window.addEventListener('pagehide', () => finish(true));
        render();
        return next => {
            if (drag && !sameOrder(next[key] || defaults, order())) finish(true);
            settings = next;
            render();
        };
    });
    return { populate: settings => lists.forEach(populate => populate(settings)) };
};
