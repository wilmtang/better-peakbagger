// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Opt-in column docking. The owning surface chooses targets and persistence;
// this controller never registers other cards or touches browser storage.
export function createCardDrag({ card, handle, surface = handle, status, name = 'Card', getTargets, getPosition, onMove, enabled = () => true }) {
    const doc = card.ownerDocument, view = doc.defaultView;
    const preview = doc.createElement('div');
    preview.className = 'bpb-card-drop-preview'; preview.hidden = true; preview.setAttribute('aria-hidden', 'true');
    const previewLabel = doc.createElement('span'); previewLabel.className = 'bpb-card-drop-preview-label'; preview.append(previewLabel);
    doc.body.append(preview);
    let drag = null, disposed = false, suppressClick = false, animation = null;
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
        const rect = bounds(target), top = Math.max(8, rect.top), bottom = Math.min(view.innerHeight - 8, rect.bottom);
        if (bottom <= top) { preview.hidden = true; return; }
        previewLabel.textContent = `Move ${name.toLowerCase()} ${target.label}`;
        Object.assign(preview.style, { left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, height: `${bottom - top}px` });
    };
    const refresh = () => {
        const active = available(), list = targets(), next = list.find(target => target.id !== getPosition());
        handle.hidden = !active;
        card.classList.toggle('bpb-card-movable', active);
        if (next) {
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
    const finish = commit => {
        if (!drag) return;
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
    const cancel = () => { finish(false); animation?.cancel(); animation = null; };
    const down = event => {
        if (!available() || drag || event.button !== 0 || event.isPrimary === false) return;
        const control = event.target.closest?.('button, a, input, select, textarea, summary, [contenteditable], [role="tab"]');
        if (control && control !== handle) return;
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || card.getBoundingClientRect().width <= 0) return;
        animation?.cancel(); animation = null; suppressClick = false;
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
            try { handle.setPointerCapture?.(drag.pointerId); } catch { /* Window listeners still finish the gesture. */ }
        }
        if (event.cancelable) event.preventDefault();
        card.style.setProperty('--bpb-card-drag-x', `${x + view.scrollX - drag.scrollX}px`);
        card.style.setProperty('--bpb-card-drag-y', `${y + view.scrollY - drag.scrollY}px`);
        drag.target = targetAt(event.clientX, event.clientY);
        showTarget(drag.target);
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
        if (event.metaKey || event.ctrlKey || event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const list = targets(), index = list.findIndex(target => target.id === getPosition());
        const target = list[index + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (!available()) return;
        event.preventDefault(); if (target) moveTo(target.id);
    };
    const click = event => {
        if (suppressClick && event.detail !== 0) { event.preventDefault(); suppressClick = false; return; }
        suppressClick = false;
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
        disposed = true; cancel(); preview.remove(); card.classList.remove('bpb-card-movable'); handle.hidden = true;
        surface.removeEventListener('pointerdown', down);
        handle.removeEventListener('click', click); handle.removeEventListener('keydown', key);
        handle.removeEventListener('lostpointercapture', interrupted);
        view.removeEventListener('pointermove', move, true); view.removeEventListener('pointerup', up, true);
        view.removeEventListener('pointercancel', interrupted, true); view.removeEventListener('keydown', escape, true);
        view.removeEventListener('blur', cancel); view.removeEventListener('resize', cancel);
    } };
}
