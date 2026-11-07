// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a finished topo leaves the editor without ImgBB: a file name for Export,
// the clipboard write for Copy, and the one rule that decides what the finish
// actions say and which of them is primary. Pure: no extension APIs, so every
// row of the finish-state table is unit-testable.

export type FinishContext = 'standalone' | 'report-insert' | 'report-replace' | 'local';
export type KeyMode = 'none' | 'device' | 'tab';
export type Emphasis = 'primary' | 'secondary' | 'quiet';

export interface FinishInput {
    context: FinishContext;
    keyMode: KeyMode;
    remoteState: string | null;
    insertionConfirmed?: boolean;
    localReturned?: boolean;
    pendingKey?: boolean;
    overGithubLimit?: boolean;
    // This tab's own upload is running; `uploading` then means in progress,
    // not an earlier attempt whose outcome is unknown.
    uploadInFlight?: boolean;
}

export interface FinishSlot {
    kind: 'upload' | 'copy-link' | 'status';
    label: string;
    // The widest label this slot can show in this context, reserved so a
    // state change never moves the actions beside it.
    sizingLabel: string;
    emphasis: Emphasis;
}

export interface FinishState {
    slot: FinishSlot;
    exportEmphasis: Emphasis;
    // Standalone sessions are for getting the picture out, so local actions
    // come last and the publish action stands apart before them; report
    // sessions are for inserting, so the upload slot is the trailing primary.
    uploadFirst: boolean;
    note: { kind: 'outcome-unknown' | 'needs-host' | 'github-size' | 'tab-key'; text: string } | null;
}

const PUBLISHED = new Set(['uploaded', 'unreachable']);
const UNRESOLVED = new Set(['uploading', 'outcome-unknown']);

const UPLOAD_LABELS: Record<Exclude<FinishContext, 'local'>, string> = {
    standalone: 'Upload to ImgBB',
    'report-insert': 'Upload and insert',
    'report-replace': 'Upload and replace',
};

export const NOTES = Object.freeze({
    'outcome-unknown': 'An earlier upload may have reached ImgBB. Check your account before uploading again.',
    'needs-host': 'Reports need a hosted image. Connect ImgBB to insert it, or export it and host it anywhere.',
    'github-size': 'Over 5 MB · GitHub may not show this image in backed-up reports.',
    'tab-key': 'ImgBB key for this tab only',
});

export const finishState = ({
    context, keyMode, remoteState, insertionConfirmed = false, localReturned = false,
    pendingKey = false, overGithubLimit = false, uploadInFlight = false,
}: FinishInput): FinishState => {
    const standalone = context === 'standalone';
    const report = context === 'report-insert' || context === 'report-replace';
    const keyAvailable = keyMode !== 'none' || pendingKey;
    let slot: FinishSlot;
    if (context === 'local') {
        const sizingLabel = 'Saved to report';
        slot = localReturned
            ? { kind: 'status', label: 'Saved to report', sizingLabel, emphasis: 'primary' }
            : { kind: 'upload', label: 'Save and return', sizingLabel, emphasis: 'primary' };
    } else {
        const base = UPLOAD_LABELS[context];
        const sizingLabel = [`${base}…`, 'Copy link', report ? 'Inserted' : ''].reduce((a, b) => (b.length > a.length ? b : a));
        if (remoteState && PUBLISHED.has(remoteState)) {
            slot = report && insertionConfirmed
                ? { kind: 'status', label: 'Inserted', sizingLabel, emphasis: 'primary' }
                : { kind: 'copy-link', label: 'Copy link', sizingLabel, emphasis: standalone ? 'quiet' : 'primary' };
        } else {
            // This tab's own upload in progress keeps the button the user pressed
            // as it was; only an outcome nobody here is waiting on demotes it.
            const unresolved = !!remoteState && UNRESOLVED.has(remoteState)
                && !(remoteState === 'uploading' && uploadInFlight);
            slot = {
                kind: 'upload',
                label: keyAvailable ? base : `${base}…`,
                sizingLabel,
                emphasis: standalone ? 'quiet' : unresolved ? 'secondary' : 'primary',
            };
        }
    }
    const note = remoteState === 'outcome-unknown' || (remoteState === 'uploading' && !uploadInFlight)
        ? 'outcome-unknown'
        : report && !keyAvailable && !(remoteState && PUBLISHED.has(remoteState))
            ? 'needs-host'
            : report && overGithubLimit
                ? 'github-size'
                : keyMode === 'tab' && !pendingKey && context !== 'local'
                    ? 'tab-key'
                    : null;
    return {
        slot,
        exportEmphasis: standalone ? 'primary' : 'secondary',
        uploadFirst: standalone,
        note: note ? { kind: note, text: NOTES[note] } : null,
    };
};

// Characters no mainstream file system accepts, plus controls and the
// separators that would turn a title into a path.
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const FILE_NAME_MAX_BYTES = 200;

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

// Trim on code point boundaries so a multibyte title never ends in half a
// character.
const clampBytes = (value: string, maxBytes: number) => {
    let result = '';
    for (const character of value) {
        if (utf8Length(result + character) > maxBytes) break;
        result += character;
    }
    return result;
};

export const exportFileName = (title: string | null | undefined, mime: string) => {
    const extension = mime === 'image/png' ? 'png' : 'jpg';
    const suffix = `-topo.${extension}`;
    let stem = String(title ?? '')
        .normalize('NFC')
        .replace(UNSAFE, ' ')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-. ]+$/g, '');
    stem = clampBytes(stem, FILE_NAME_MAX_BYTES - utf8Length(suffix)).replace(/[-. ]+$/g, '');
    const name = `${stem}${suffix}`;
    // Windows reserves a device name before the first dot of the whole name.
    if (!stem || WINDOWS_RESERVED.test(name.split('.')[0])) return `photo${suffix}`;
    return name;
};

interface ClipboardLike { write(items: ClipboardItem[]): Promise<void> }
type ClipboardItemConstructor = new (items: Record<string, Promise<Blob> | Blob>) => ClipboardItem;

export const clipboardImageSupported = ({
    clipboard = globalThis.navigator?.clipboard as ClipboardLike | undefined,
    ClipboardItemCtor = (globalThis as { ClipboardItem?: ClipboardItemConstructor }).ClipboardItem,
}: { clipboard?: ClipboardLike; ClipboardItemCtor?: ClipboardItemConstructor } = {}) =>
    typeof ClipboardItemCtor === 'function' && typeof clipboard?.write === 'function';

// The write has to start inside the click's user activation, and a
// full-resolution PNG encode can outlast it. Building the item from the
// pending encode, and calling write() before anything awaits, keeps the
// activation for the whole encode in both Chrome and Firefox.
export const writeImageToClipboard = ({
    encode,
    clipboard = globalThis.navigator?.clipboard as ClipboardLike,
    ClipboardItemCtor = (globalThis as { ClipboardItem?: ClipboardItemConstructor }).ClipboardItem!,
}: {
    encode: () => Promise<Blob>;
    clipboard?: ClipboardLike;
    ClipboardItemCtor?: ClipboardItemConstructor;
}) => {
    const pending = encode();
    // The browser owns this promise once it is in the item; observe its
    // rejection here too so a failed encode is not also reported as unhandled.
    pending.catch(() => {});
    return clipboard.write([new ClipboardItemCtor({ 'image/png': pending })]);
};

// A download link needs its object URL until the browser has taken the bytes;
// Firefox reads it after the click returns, so the URL outlives the click by
// long enough for a large file to start.
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;

export const downloadBlob = ({
    blob, fileName,
    documentImpl = globalThis.document,
    URLImpl = globalThis.URL,
    setTimeoutImpl = globalThis.setTimeout,
}: {
    blob: Blob; fileName: string;
    documentImpl?: Document; URLImpl?: typeof URL; setTimeoutImpl?: typeof setTimeout;
}) => {
    const url = URLImpl.createObjectURL(blob);
    const link = documentImpl.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.hidden = true;
    documentImpl.body.append(link);
    try { link.click(); } finally { link.remove(); }
    setTimeoutImpl(() => URLImpl.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
};

export const photoOutput = {
    NOTES, FILE_NAME_MAX_BYTES, DOWNLOAD_URL_LIFETIME_MS,
    finishState, exportFileName, clipboardImageSupported, writeImageToClipboard, downloadBlob,
};
