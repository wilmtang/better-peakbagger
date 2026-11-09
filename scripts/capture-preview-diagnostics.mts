/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export type PreviewEvent = { kind: 'click' | 'submit' | 'invalid'; prevented: boolean; connected: boolean; disabled: boolean; files: number };
export function sanitizePreviewEvent(input: unknown): PreviewEvent | null {
    if (!input || typeof input !== 'object') return null;
    const value = input as Record<string, unknown>;
    if (typeof value.kind !== 'string' || !['click', 'submit', 'invalid'].includes(value.kind)
        || typeof value.prevented !== 'boolean' || typeof value.connected !== 'boolean'
        || typeof value.disabled !== 'boolean' || typeof value.files !== 'number'
        || !Number.isInteger(value.files) || value.files < 0 || value.files > 10) return null;
    return { kind: value.kind as PreviewEvent['kind'], prevented: value.prevented,
        connected: value.connected, disabled: value.disabled, files: value.files };
}
declare global { interface Window { __bpbRecordPreview?: (event: PreviewEvent) => Promise<void> } }

// Serialized into synthetic fixture pages before extension injection. Only fixed
// native-control state is recorded; never values, filenames, URLs or form data.
export function installPreviewProbe() {
    if (location.hostname !== 'www.peakbagger.com' || !location.pathname.toLowerCase().endsWith('/ascentedit.aspx')) return;
    let count = 0;
    for (const kind of ['click', 'submit', 'invalid'] as const) document.addEventListener(kind, event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (kind === 'click' && target.id !== 'GPXPreview') return;
        const form = target instanceof HTMLFormElement ? target : target.closest('form');
        if (!form || !form.querySelector('#GPXPreview') || count++ >= 64) return;
        const preview = form.querySelector<HTMLButtonElement | HTMLInputElement>('#GPXPreview');
        const upload = form.querySelector<HTMLInputElement>('#GPXUpload');
        queueMicrotask(() => { void window.__bpbRecordPreview?.({ kind, prevented: event.defaultPrevented,
            connected: form.isConnected, disabled: !!preview?.disabled, files: upload?.files?.length ?? 0 }); });
    }, true);
}

export function captureProfileCount(args: string[]) {
    if (args.length === 0) return 1;
    if (args.length !== 2 || args[0] !== '--fresh-profiles' || !/^[1-5]$/.test(args[1]!)) {
        throw new Error('Usage: verify-capture-flow.mts [--fresh-profiles 1..5]');
    }
    return Number(args[1]);
}
