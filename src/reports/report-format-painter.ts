// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the format painter's armed state and gestures. The copied
// format and the transaction that applies it belong to report-rich-editor.ts;
// this module decides when to copy and when to apply.
//
// A pointer selection applies as soon as it ends. A keyboard selection grows one
// key at a time, so it applies only on an explicit shortcut. Any other edit
// cancels, so the format can never land on text the writer has moved on from.

// Long enough to see the third press of a triple-click, so selecting a whole
// paragraph does not first paint only the word under the pointer.
const TRIPLE_CLICK_WINDOW_MS = 350;

export type PainterMode = 'idle' | 'once' | 'locked';

interface PainterOptions<Format> {
    surface: Element;
    copy: () => Format | null;
    paint: (format: Format) => boolean;
    onChange: (mode: PainterMode) => void;
}
interface TransactionLike { docChanged: boolean; getMeta(key: string): unknown }

export const createFormatPainter = <Format>({ surface, copy, paint, onChange }: PainterOptions<Format>) => {
    const doc = surface.ownerDocument;
    let mode: PainterMode = 'idle';
    let format: Format | null = null;
    let painting = false;
    let pointerInSurface = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const setMode = (next: PainterMode) => {
        if (mode === next) return;
        mode = next;
        onChange(next);
    };
    const onMouseDown = (event: Event) => {
        clearTimer();
        pointerInSurface = surface.contains(event.target as Node);
    };
    const onMouseUp = (event: Event) => {
        if (!pointerInSurface) return;
        pointerInSurface = false;
        clearTimer();
        // The editor reads the final selection after this event, so apply on the
        // next task at the earliest.
        timer = setTimeout(() => { timer = null; apply(); },
            (event as MouseEvent).detail === 2 ? TRIPLE_CLICK_WINDOW_MS : 0);
    };

    const cancel = () => {
        if (mode === 'idle') return;
        clearTimer();
        pointerInSurface = false;
        format = null;
        doc.removeEventListener('mousedown', onMouseDown, true);
        doc.removeEventListener('mouseup', onMouseUp, true);
        setMode('idle');
    };
    const arm = (next: 'once' | 'locked') => {
        const copied = copy();
        if (copied === null) return false;
        format = copied;
        if (mode === 'idle') {
            doc.addEventListener('mousedown', onMouseDown, true);
            doc.addEventListener('mouseup', onMouseUp, true);
        }
        setMode(next);
        return true;
    };
    // An empty selection or a selected photo leaves the painter armed, so a stray
    // click never spends it.
    function apply() {
        if (mode === 'idle' || format === null) return false;
        painting = true;
        let applied = false;
        try { applied = paint(format); } finally { painting = false; }
        if (applied && mode === 'once') cancel();
        return applied;
    }

    return {
        mode: () => mode,
        arm,
        cancel,
        apply,
        // The toolbar button: a press arms once, a double-click or Shift+activation
        // stays armed, and a further press finishes.
        press: ({ detail = 0, shiftKey = false }: { detail?: number; shiftKey?: boolean }) => {
            if (detail === 2 || (mode === 'idle' && shiftKey)) return arm('locked');
            if (mode !== 'idle') { cancel(); return false; }
            return arm('once');
        },
        // Undo stays available for a mistaken stroke without ending a locked run.
        noteTransaction: (transaction: TransactionLike) => {
            if (mode !== 'idle' && !painting && transaction.docChanged && !transaction.getMeta('history$')) cancel();
        },
    };
};
