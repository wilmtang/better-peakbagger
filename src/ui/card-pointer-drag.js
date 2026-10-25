// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared input/capture/cancellation/autoscroll mechanics. Surface adapters own
// destinations, previews, DOM movement, keyboard policy and persistence.
export function createCardPointerDrag({ view, enabled, onMove, onFinish, onCancel, onScroll, captureOnPress = false }) {
    let pointer = null, frame = null, disposed = false;
    const capture = () => { try { pointer.handle.setPointerCapture?.(pointer.id); } catch { /* Window events remain authoritative. */ } };
    const release = () => {
        const previous = pointer; pointer = null;
        if (frame !== null) view.cancelAnimationFrame(frame); frame = null;
        if (previous) {
            previous.handle.removeEventListener('lostpointercapture', interrupted);
            try { previous.handle.releasePointerCapture?.(previous.id); } catch { /* Capture may already be gone. */ }
        }
    };
    const cancel = event => { if (!pointer) return; release(); onCancel(event); };
    const scroll = () => {
        frame = null;
        if (!pointer?.active) return;
        const edge = 56, speed = pointer.y < edge ? -Math.ceil((edge - pointer.y) / 4)
            : pointer.y > view.innerHeight - edge ? Math.ceil((pointer.y - view.innerHeight + edge) / 4) : 0;
        if (speed) { view.scrollBy(0, Math.max(-18, Math.min(18, speed))); onScroll(); }
        frame = view.requestAnimationFrame(scroll);
    };
    const move = event => {
        if (!pointer || event.pointerId !== pointer.id) return;
        if (!enabled()) { cancel(event); return; }
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        if (!pointer.active && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
        if (!pointer.active) { pointer.active = true; if (!captureOnPress) capture(); frame = view.requestAnimationFrame(scroll); }
        pointer.y = event.clientY;
        if (event.cancelable) event.preventDefault();
        onMove(event);
    };
    const up = event => {
        if (!pointer || event.pointerId !== pointer.id) return;
        if (!enabled() || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) { cancel(event); return; }
        release(); onFinish(event);
    };
    function interrupted(event) { if (pointer?.id === event.pointerId) cancel(event); }
    const escape = event => {
        if (event.key !== 'Escape' || !pointer) return;
        event.preventDefault(); event.stopPropagation(); cancel(event);
    };
    const unavailable = event => { if (pointer) cancel(event); else onCancel(event); };
    view.addEventListener('pointermove', move, { capture: true, passive: false });
    view.addEventListener('pointerup', up, true); view.addEventListener('pointercancel', interrupted, true);
    view.addEventListener('keydown', escape, true); view.addEventListener('blur', unavailable); view.addEventListener('resize', unavailable);
    return {
        start(event, handle) {
            if (disposed || pointer || !enabled() || !handle.isConnected || event.button !== 0 || event.isPrimary === false
                || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
            const control = event.target.closest?.('button, a, input, select, textarea, summary, [contenteditable], [role="tab"]');
            if (control && control !== handle) return false;
            pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, handle, active: false };
            handle.addEventListener('lostpointercapture', interrupted);
            if (captureOnPress) capture();
            return true;
        },
        cancel,
        dispose() {
            if (disposed) return;
            disposed = true; cancel();
            view.removeEventListener('pointermove', move, true); view.removeEventListener('pointerup', up, true);
            view.removeEventListener('pointercancel', interrupted, true); view.removeEventListener('keydown', escape, true);
            view.removeEventListener('blur', unavailable); view.removeEventListener('resize', unavailable);
        },
    };
}
