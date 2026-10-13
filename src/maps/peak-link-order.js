// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Only extension-owned planning links participate; native links and the
// unconfigured-forecast notice keep their original behavior and position.
export function enablePeakLinkOrder({ section, list, settings }) {
    const doc = section.ownerDocument, view = doc.defaultView;
    const items = new Map([...list.querySelectorAll('[data-link-key]')]
        .map(item => [item.dataset.linkKey, item]));
    const instructions = doc.createElement('span');
    instructions.id = 'bpb-peak-links-reorder-help';
    instructions.className = 'bpb-peak-links__sr';
    instructions.textContent = 'Drag to reorder, or use the Up and Down arrow keys. Escape cancels a drag.';
    const status = doc.createElement('div');
    status.className = 'bpb-peak-links__status bpb-peak-links__sr';
    status.setAttribute('role', 'status');
    section.append(instructions, status);

    let fullOrder = [...settings.DEFAULTS.peakLinkOrder];
    let order = [...items.keys()], drag = null, revision = 0;
    const animations = new Map();
    const reducedMotion = () => view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const label = key => items.get(key).querySelector('a').textContent;
    const announce = key => {
        if (!status.hasAttribute('data-error')) {
            status.textContent = `${label(key)} moved to position ${order.indexOf(key) + 1} of ${order.length}.`;
        }
    };
    const animate = (item, from, duration = 180) => {
        if (reducedMotion() || !item.animate || Math.abs(from) < .5) return;
        const animation = item.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
            { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        animations.set(item, animation);
        const forget = () => { if (animations.get(item) === animation) animations.delete(item); };
        animation.addEventListener('finish', forget, { once: true });
        animation.addEventListener('cancel', forget, { once: true });
    };
    const apply = (next, moving = null, motion = true) => {
        if (next.every((key, index) => key === order[index])) return;
        const before = new Map([...items.values()].map(item => [item, item.getBoundingClientRect().top]));
        for (const animation of animations.values()) animation.cancel();
        animations.clear();
        const focused = section.ownerDocument.activeElement;
        order = next;
        // Keep any non-link notice after the reorderable rows.
        const notice = list.querySelector(':scope > :not([data-link-key])');
        for (const key of order) list.insertBefore(items.get(key), notice);
        if (section.contains(focused)) focused.focus({ preventScroll: true });
        if (motion) for (const [item, top] of before) {
            if (item !== moving) animate(item, top - item.getBoundingClientRect().top);
        }
    };
    const persist = key => {
        revision++;
        const currentRevision = revision;
        const visible = [...order];
        // Replace only visible slots, so moving links in Europe does not lose
        // the user's AirNow position or additional border-peak forecast slots.
        fullOrder = fullOrder.map(id => items.has(id) ? visible.shift() : id);
        announce(key);
        void settings.set({ peakLinkOrder: [...fullOrder] }).then(() => {
            if (currentRevision !== revision) return;
            status.removeAttribute('data-error');
            status.classList.add('bpb-peak-links__sr');
            announce(key);
        }).catch(() => {
            if (currentRevision !== revision) return;
            status.setAttribute('data-error', '');
            status.classList.remove('bpb-peak-links__sr');
            status.textContent = 'Link order could not be saved. Move a link again to retry.';
        });
    };
    const updatePosition = event => {
        drag.lastY = event.clientY;
        drag.y = event.clientY + view.scrollY - drag.startPageY - (drag.item.offsetTop - drag.startTop);
        // Keep the lifted row inside its list rather than covering native links.
        if (list.offsetHeight >= drag.item.offsetHeight) {
            drag.y = Math.max(-drag.item.offsetTop,
                Math.min(list.offsetHeight - drag.item.offsetHeight - drag.item.offsetTop, drag.y));
        }
        drag.item.style.setProperty('--bpb-link-drag-y', `${drag.y}px`);
    };
    const finish = cancelled => {
        if (!drag) return;
        const current = drag;
        if (current.active && cancelled) {
            apply(current.order, current.item);
            updatePosition({ clientY: current.lastY });
        }
        drag = null;
        try { current.handle.releasePointerCapture?.(current.pointerId); } catch { /* already released */ }
        current.item.removeAttribute('data-dragging');
        list.removeAttribute('data-reordering');
        current.item.style.removeProperty('--bpb-link-drag-y');
        if (!current.active) return;
        animate(current.item, current.y, 200);
        if (cancelled) {
            if (!status.hasAttribute('data-error')) status.textContent = 'Link reordering canceled.';
        } else if (order.some((key, index) => key !== current.order[index])) persist(current.key);
    };

    for (const [key, item] of items) {
        const handle = doc.createElement('button');
        handle.type = 'button';
        handle.className = 'bpb-peak-links__grip';
        handle.setAttribute('aria-label', `Reorder ${label(key)}`);
        handle.setAttribute('aria-describedby', instructions.id);
        handle.title = 'Drag to reorder · ↑ / ↓ to move';
        const dots = doc.createElement('span');
        dots.setAttribute('aria-hidden', 'true');
        handle.append(dots);
        item.prepend(handle);
        handle.addEventListener('keydown', event => {
            if (drag || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const from = order.indexOf(key);
            const to = event.key === 'ArrowUp' ? from - 1 : event.key === 'ArrowDown' ? from + 1
                : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : null;
            if (to === null) return;
            event.preventDefault();
            if (to < 0 || to >= order.length || to === from) {
                if (!status.hasAttribute('data-error')) status.textContent = `${label(key)} is already ${from === 0 ? 'first' : 'last'}.`;
                return;
            }
            const next = order.filter(id => id !== key);
            next.splice(to, 0, key);
            apply(next);
            persist(key);
        });
        handle.addEventListener('pointerdown', event => {
            if (drag || event.isPrimary === false || event.button !== 0) return;
            for (const animation of animations.values()) animation.cancel();
            animations.clear();
            handle.focus({ preventScroll: true });
            drag = { key, item, handle, pointerId: event.pointerId, order: [...order],
                startY: event.clientY, lastY: event.clientY, startPageY: event.clientY + view.scrollY,
                startTop: item.offsetTop, center: item.getBoundingClientRect().top + item.offsetHeight / 2,
                y: 0, active: false };
            try { handle.setPointerCapture?.(event.pointerId); } catch { /* window listeners remain available */ }
        });
    }
    list.addEventListener('dragstart', event => {
        if (drag) event.preventDefault();
    });
    view.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.active && Math.abs(event.clientY - drag.startY) < 6) return;
        drag.active = true;
        drag.item.setAttribute('data-dragging', '');
        list.setAttribute('data-reordering', '');
        if (event.cancelable) event.preventDefault();
        updatePosition(event);
        const bounds = list.getBoundingClientRect();
        if (event.clientX < bounds.left - 16 || event.clientX > bounds.right + 16) return;
        const center = drag.center + event.clientY - drag.startY;
        const next = order.filter(key => key !== drag.key);
        const to = next.filter(key => {
            const item = items.get(key);
            return center > bounds.top + item.offsetTop + item.offsetHeight / 2;
        }).length;
        next.splice(to, 0, drag.key);
        apply(next, drag.item);
        updatePosition(event);
        try { drag.handle.setPointerCapture?.(event.pointerId); } catch { /* pointer may have ended */ }
    }, { passive: false });
    view.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const bounds = list.getBoundingClientRect();
        finish(event.clientX < bounds.left - 16 || event.clientX > bounds.right + 16
            || event.clientY < bounds.top - 16 || event.clientY > bounds.bottom + 16);
    });
    view.addEventListener('pointercancel', event => {
        if (drag?.pointerId === event.pointerId) finish(true);
    });
    view.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); }
    });
    view.addEventListener('blur', () => finish(true));
    view.addEventListener('pagehide', () => finish(true));
    view.addEventListener('resize', () => finish(true));

    const initialRevision = revision;
    void settings.get().then(saved => {
        // A late storage read must never undo a move already made by the user.
        if (revision !== initialRevision || drag) return;
        fullOrder = [...saved.peakLinkOrder];
        apply(fullOrder.filter(key => items.has(key)), null, false);
    });
}
