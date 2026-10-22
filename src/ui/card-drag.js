// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLayoutMenu } from './layout-menu.js';

// Opt-in column docking. The owning surface chooses targets and persistence;
// this controller never registers other cards or touches browser storage.
export function createCardDrag({ card, handle, surface = handle, status, name = 'Card', getTargets, getPosition, onMove, enabled = () => true }) {
    const doc = card.ownerDocument, view = doc.defaultView;
    const preview = doc.createElement('div');
    preview.className = 'bpb-card-drop-preview'; preview.hidden = true; preview.setAttribute('aria-hidden', 'true');
    const previewLabel = doc.createElement('span'); previewLabel.className = 'bpb-card-drop-preview-label'; preview.append(previewLabel);
    doc.body.append(preview);
    let drag = null, disposed = false, suppressClick = false, animation = null, frame = null;
    const targets = () => getTargets().filter(target => target.element?.isConnected);
    const available = () => !disposed && enabled() && targets().length > 1;
    const reducedMotion = () => view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const bounds = target => target.bounds?.() || target.element.getBoundingClientRect();
    const targetAt = (x, y) => targets().find(target => {
        const rect = bounds(target);
        return rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    const showTarget = target => {
        preview.hidden = !target;
        if (!target) return;
        const rect = target.previewBounds?.() || bounds(target), top = Math.max(8, rect.top), bottom = Math.min(view.innerHeight - 8, rect.bottom);
        if (bottom <= top) { preview.hidden = true; return; }
        preview.toggleAttribute('data-insertion', !!target.previewBounds);
        previewLabel.textContent = `Move ${name.toLowerCase()} ${target.label}`;
        Object.assign(preview.style, { left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${bottom - top}px` });
    };
    const refresh = () => {
        const active = available(), list = targets(), next = list.find(target => target.id !== getPosition());
        handle.hidden = !active;
        card.classList.toggle('bpb-card-movable', active);
        if (list.some(target => target.column)) {
            handle.setAttribute('aria-label', `Reorder ${name.toLowerCase()} card`);
            handle.title = 'Drag to move. Click for move options. Arrow keys change position or column.';
        } else if (next) {
            handle.setAttribute('aria-label', `Move ${name.toLowerCase()} ${next.label}`);
            handle.title = `Drag to move the ${name.toLowerCase()} card. Click to move ${next.label}.`;
        }
        if (!active) cancel();
    };
    const moveTo = id => {
        if (!available() || id === getPosition()) return false;
        const target = targets().find(candidate => candidate.id === id);
        if (!target || onMove(id) === false) return false;
        refresh();
        status.textContent = `${name} moved ${target.label}.`;
        handle.focus({ preventScroll: true });
        handle.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        return true;
    };
    const redraw = () => {
        if (!drag?.active) return;
        card.style.setProperty('--bpb-card-drag-x', `${drag.clientX - drag.x + view.scrollX - drag.scrollX}px`);
        card.style.setProperty('--bpb-card-drag-y', `${drag.clientY - drag.y + view.scrollY - drag.scrollY}px`);
        drag.target = targetAt(drag.clientX, drag.clientY); showTarget(drag.target);
    };
    const autoscroll = () => {
        frame = null;
        if (!drag?.active) return;
        const edge = 56, y = drag.clientY, speed = y < edge ? -Math.ceil((edge - y) / 4)
            : y > view.innerHeight - edge ? Math.ceil((y - view.innerHeight + edge) / 4) : 0;
        if (speed) { view.scrollBy(0, Math.max(-18, Math.min(18, speed))); redraw(); }
        frame = view.requestAnimationFrame(autoscroll);
    };
    const finish = commit => {
        if (!drag) return;
        if (frame !== null) view.cancelAnimationFrame(frame); frame = null;
        const previous = drag, before = card.getBoundingClientRect();
        drag = null;
        preview.hidden = true;
        card.removeAttribute('data-bpb-card-dragging');
        card.style.removeProperty('--bpb-card-drag-x'); card.style.removeProperty('--bpb-card-drag-y');
        doc.documentElement.classList.remove('bpb-card-drag-active');
        try { handle.releasePointerCapture?.(previous.pointerId); } catch { /* Capture may already be gone. */ }
        if (!previous.active) return;
        suppressClick = true;
        const moved = commit && previous.target && moveTo(previous.target.id);
        if (!moved && !commit) status.textContent = `${name} move canceled.`;
        const after = card.getBoundingClientRect(), x = before.left - after.left, y = before.top - after.top;
        if (!disposed && !reducedMotion() && typeof card.animate === 'function' && Math.hypot(x, y) <= view.innerHeight) {
            animation = card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
                { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        }
    };
    const cancel = () => { menu.close(); finish(false); animation?.cancel(); animation = null; };
    const down = event => {
        if (!available() || drag || event.button !== 0 || event.isPrimary === false) return;
        const control = event.target.closest?.('button, a, input, select, textarea, summary, [contenteditable], [role="tab"]');
        if (control && control !== handle) return;
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || card.getBoundingClientRect().width <= 0) return;
        menu.close(); animation?.cancel(); animation = null; suppressClick = false;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            scrollX: view.scrollX, scrollY: view.scrollY, active: false, target: null };
    };
    const move = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!available()) { cancel(); return; }
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        const x = event.clientX - drag.x, y = event.clientY - drag.y;
        if (!drag.active && Math.hypot(x, y) < 6) return;
        if (!drag.active) {
            drag.active = true;
            card.setAttribute('data-bpb-card-dragging', '');
            doc.documentElement.classList.add('bpb-card-drag-active');
            frame = view.requestAnimationFrame(autoscroll);
            try { handle.setPointerCapture?.(drag.pointerId); } catch { /* Window listeners still finish the gesture. */ }
        }
        if (event.cancelable) event.preventDefault();
        drag.clientX = event.clientX; drag.clientY = event.clientY; redraw();
    };
    const up = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.active) { drag.target = targetAt(event.clientX, event.clientY); }
        finish(true);
    };
    const interrupted = event => { if (drag && event.pointerId === drag.pointerId) cancel(); };
    const escape = event => {
        if (event.key !== 'Escape' || !drag) return;
        event.preventDefault(); event.stopPropagation(); cancel();
    };
    const key = event => {
        if (drag || event.metaKey || event.ctrlKey || event.altKey || !available()) return;
        const list = targets(), current = list.find(target => target.id === getPosition());
        let target;
        if (current?.column) {
            const same = list.filter(candidate => candidate.column === current.column), index = same.indexOf(current);
            if (event.key === 'ArrowUp') target = same[index - 1];
            else if (event.key === 'ArrowDown') target = same[index + 1];
            else if (event.key === 'Home') target = same[0];
            else if (event.key === 'End') target = same.at(-1);
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const columns = [...new Set(list.map(candidate => candidate.column))], at = columns.indexOf(current.column);
                const column = columns[at + (event.key === 'ArrowLeft' ? -1 : 1)];
                target = list.filter(candidate => candidate.column === column).at(-1);
            } else return;
        } else {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const index = list.findIndex(candidate => candidate.id === getPosition());
            target = list[index + (event.key === 'ArrowLeft' ? -1 : 1)];
        }
        event.preventDefault(); if (target) moveTo(target.id);
    };
    const menu = createLayoutMenu({ handle, label: `Move ${name.toLowerCase()}`, actions: () => targets().map(target => ({
        label: `Move ${target.label}`, disabled: target.id === getPosition(), run: () => moveTo(target.id),
    })) });
    const click = event => {
        if (drag || !available()) return;
        if (suppressClick && event.detail !== 0) { event.preventDefault(); suppressClick = false; return; }
        suppressClick = false;
        if (targets().some(target => target.column)) { menu.toggle(); return; }
        const next = targets().find(target => target.id !== getPosition());
        if (next) moveTo(next.id);
    };
    surface.addEventListener('pointerdown', down);
    handle.addEventListener('click', click); handle.addEventListener('keydown', key);
    handle.addEventListener('lostpointercapture', interrupted);
    view.addEventListener('pointermove', move, { capture: true, passive: false });
    view.addEventListener('pointerup', up, true); view.addEventListener('pointercancel', interrupted, true);
    view.addEventListener('keydown', escape, true); view.addEventListener('blur', cancel); view.addEventListener('resize', cancel);
    refresh();
    return { refresh, cancel, get dragging() { return drag !== null; }, dispose() {
        if (disposed) return;
        disposed = true; cancel(); menu.dispose(); preview.remove(); card.classList.remove('bpb-card-movable'); handle.hidden = true;
        surface.removeEventListener('pointerdown', down);
        handle.removeEventListener('click', click); handle.removeEventListener('keydown', key);
        handle.removeEventListener('lostpointercapture', interrupted);
        view.removeEventListener('pointermove', move, true); view.removeEventListener('pointerup', up, true);
        view.removeEventListener('pointercancel', interrupted, true); view.removeEventListener('keydown', escape, true);
        view.removeEventListener('blur', cancel); view.removeEventListener('resize', cancel);
    } };
}
