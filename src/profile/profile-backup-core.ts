// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure profile-backup primitives shared by the ClimbListC content script and
// fixture/unit tests. No extension APIs or ambient document are read here.

import { PEAKBAGGER_ORIGIN } from '../peakbagger/peakbagger-origin.ts';
import { classifyResponse } from '../peakbagger/peakbagger-response.ts';
import { peakbaggerAccount, type AccountDocumentLike } from '../peakbagger/peakbagger-account.ts';
export { classifyResponse } from '../peakbagger/peakbagger-response.ts';

export interface AscentListDocument extends AccountDocumentLike {
    readonly baseURI?: string;
}

export interface ParseAscentListOptions {
    url?: string | null;
}

export interface AscentListEntry {
    aid: number;
    pid: number;
    peakName: string;
    date: string;
    hasGpx: boolean;
    trWords: number;
    ascentUrl: string;
    editUrl: string | null;
}

export interface ParsedAscentList {
    isOwner: boolean;
    climberId: number | null;
    ascents: AscentListEntry[];
}

export type ExistingFolderInput = string | { readonly path?: unknown } | null | undefined;

export interface BuildWorkListOptions {
    refreshAll?: boolean;
}

export interface BackupWorkList<T extends { readonly aid: number } = AscentListEntry> {
    work: T[];
    skipped: T[];
    existing: Set<number>;
}

export interface SleepOptions {
    signal?: AbortSignal;
}

export interface BackupPayloadData {
    snapshot?: unknown;
    gpx?: string | null;
}

export interface BackupRunnerItem {
    readonly aid: number;
    readonly peakName?: string;
    readonly ascentUrl?: string;
    readonly editUrl?: string | null;
}

export interface LoadItemOptions {
    probe: boolean;
    probeUrl: string | null;
    signal: AbortSignal;
}

export interface LoadItemOkResult<TData = BackupPayloadData> {
    kind: 'ok';
    data: TData;
}

export interface LoadItemFailureResult {
    kind: string;
    url?: string | null;
    error?: unknown;
    reason?: string;
}

export type LoadItemResult<TData = BackupPayloadData> =
    | LoadItemOkResult<TData>
    | LoadItemFailureResult;

export interface PushBatchError {
    message?: string;
    code?: string;
}

export interface PushBatchResult {
    ok?: boolean;
    error?: PushBatchError | null;
}

export type ProfileBackupRunnerStatus =
    | 'idle'
    | 'running'
    | 'pause-requested'
    | 'paused'
    | 'cancel-requested'
    | 'cancelled'
    | 'complete';

export type ProfileBackupPauseReason = 'challenge' | 'transient' | 'github' | 'user';

export interface ProfileBackupFailure {
    aid: number;
    peakName: string;
    ascentUrl: string;
    reason: string;
    kind: string;
}

export interface ProfileBackupRunnerState<T extends BackupRunnerItem = AscentListEntry> {
    status: ProfileBackupRunnerStatus;
    total: number;
    queued: number;
    completed: number;
    backedUp: number;
    skipped: number;
    failures: ProfileBackupFailure[];
    current: T | null;
    fetched: number;
    buffered: number;
    bufferedBytes: number;
    uploading: number;
    producerWaiting: boolean;
    pauseReason: ProfileBackupPauseReason | null;
    pauseError: ProfileBackupFailure | null;
    pauseBatchSize: number;
    challengeUrl: string | null;
    notReached: number;
}

export interface CreateRunnerOptions<
    T extends BackupRunnerItem = AscentListEntry,
    TData = BackupPayloadData,
> {
    ascents?: readonly T[] | null;
    existingFolders?: readonly ExistingFolderInput[] | null;
    refreshAll?: boolean;
    loadItem: (item: T, options: LoadItemOptions) => Promise<LoadItemResult<TData> | null | undefined>;
    pushBatch: (batch: Array<{ item: T; data: TData }>) => Promise<PushBatchResult | null | undefined>;
    sleep?: (ms: number, options?: SleepOptions) => Promise<void>;
    onState?: (state: ProfileBackupRunnerState<T>) => void;
    paceMs?: number;
    retryDelays?: readonly number[];
    transientPauseAfter?: number;
    batchItems?: number;
    batchBytes?: number;
    bufferItems?: number;
    bufferBytes?: number;
    measureItem?: (data: TData, item: T) => number;
}

export interface ProfileBackupRunner<T extends BackupRunnerItem = AscentListEntry> {
    readonly state: ProfileBackupRunnerState<T>;
    run(): Promise<ProfileBackupRunnerState<T>>;
    pause(): void;
    resume(): Promise<ProfileBackupRunnerState<T>>;
    cancel(): void;
}

const trim = (value: unknown): string => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

export const numericParam = (
    href: string | URL | null | undefined,
    name: string,
    base: string | URL = `${PEAKBAGGER_ORIGIN}/`,
): number | null => {
    try {
        const raw = new URL(href as string | URL, base).searchParams.get(name);
        return /^-?\d+$/.test(raw || '') ? Number(raw) : null;
    } catch { return null; }
};

const findLink = (row: Element, pathPattern: RegExp): HTMLAnchorElement | null =>
    Array.from(row.querySelectorAll<HTMLAnchorElement>('a[href]')).find(anchor => {
        if (anchor.closest('tr') !== row) return false;
        try { return pathPattern.test(new URL(anchor.href, `${PEAKBAGGER_ORIGIN}/`).pathname); }
        catch { return false; }
    }) || null;

export const ownerClimberId = (doc: AccountDocumentLike | null | undefined): number | null => {
    const state = peakbaggerAccount.fromDocument(doc);
    return state.cid === null ? null : Number(state.cid);
};

const dateFromText = (value: unknown): string => {
    const text = trim(value);
    const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    return match ? match[0] : '';
};

const parseAscentList = (
    doc: AscentListDocument | null | undefined,
    { url = doc ? doc.baseURI : undefined }: ParseAscentListOptions = {},
): ParsedAscentList => {
    if (!doc || !doc.querySelectorAll) return { isOwner: false, climberId: null, ascents: [] };
    const pageClimberId = numericParam(url, 'cid', doc.baseURI);
    const ownerId = ownerClimberId(doc);
    const ascents: AscentListEntry[] = [];

    for (const row of doc.querySelectorAll('tr')) {
        const ascentLink = findLink(row, /\/climber\/ascent\.aspx$/i);
        const peakLink = findLink(row, /\/peak\.aspx$/i);
        if (!ascentLink || !peakLink) continue;
        const editLink = findLink(row, /\/climber\/ascentedit\.aspx$/i);
        const aid = numericParam(ascentLink.href, 'aid', doc.baseURI);
        const pid = numericParam(peakLink.href, 'pid', doc.baseURI);
        if (aid == null || pid == null) continue;
        const trMatch = Array.from((row as HTMLTableRowElement).cells)
            .map(cell => /^TR-(\d+)$/i.exec(trim(cell.textContent)))
            .find((match): match is RegExpExecArray => Boolean(match));
        const hasGpx = Array.from(row.querySelectorAll<HTMLImageElement>('img')).some(image =>
            /(?:^|\/)gps\.gif(?:$|[?#])/i.test(image.src || image.getAttribute('src') || '')
            || /ascent has (?:a )?gps track/i.test(image.title || ''));
        ascents.push({
            aid,
            pid,
            peakName: trim(peakLink.textContent),
            date: dateFromText(ascentLink.textContent),
            hasGpx,
            trWords: trMatch ? Number(trMatch[1]) : 0,
            ascentUrl: ascentLink.href,
            editUrl: editLink ? editLink.href : null,
        });
    }

    const isOwner = ownerId != null
        && pageClimberId === ownerId
        && ascents.every(ascent => ascent.editUrl);
    return { isOwner, climberId: isOwner ? ownerId : null, ascents: isOwner ? ascents : [] };
};

const ascentIdsFromFolders = (folders: readonly ExistingFolderInput[] | null | undefined): Set<number> =>
    new Set((Array.isArray(folders) ? folders : []).flatMap(folder => {
        const leaf = typeof folder === 'string'
            ? folder
            : folder && typeof folder.path === 'string' ? folder.path : '';
        const match = /-a(\d+)$/.exec(leaf);
        return match ? [Number(match[1])] : [];
    }));

const buildWorkList = <T extends { readonly aid: number }>(
    ascents: readonly T[] | null | undefined,
    folders: readonly ExistingFolderInput[] | null | undefined,
    { refreshAll = false }: BuildWorkListOptions = {},
): BackupWorkList<T> => {
    const existing = ascentIdsFromFolders(folders);
    const seen = new Set<number>();
    const unique = (Array.isArray(ascents) ? ascents : []).filter((ascent): ascent is T => {
        if (!ascent || !Number.isFinite(ascent.aid) || seen.has(ascent.aid)) return false;
        seen.add(ascent.aid);
        return true;
    });
    const skipped = refreshAll ? [] : unique.filter(ascent => existing.has(ascent.aid));
    const work = refreshAll ? unique : unique.filter(ascent => !existing.has(ascent.aid));
    return { work, skipped, existing };
};

const fullListUrl = (rawUrl: string | URL): string => {
    const url = new URL(rawUrl);
    url.searchParams.set('j', '-1');
    url.searchParams.set('y', '9999');
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'AscentDate');
    return url.toString();
};

const failureReason = (result: { reason?: unknown } | null | undefined): string =>
    trim(result && result.reason) || 'Peakbagger returned unexpected content.';

const messageFromError = (error: unknown): string | undefined => {
    if (error && typeof error === 'object' && 'message' in error) {
        const { message } = error as { message?: unknown };
        return typeof message === 'string' ? message : message ? String(message) : undefined;
    }
    return undefined;
};

const isOkLoadResult = <TData,>(
    result: LoadItemResult<TData> | null | undefined,
): result is LoadItemOkResult<TData> => Boolean(result && result.kind === 'ok');

const DEFAULT_BATCH_ITEMS = 10;
const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_BUFFER_ITEMS = 30;
const DEFAULT_BUFFER_BYTES = 32 * 1024 * 1024;

const cancellableSleep = (ms: number, { signal }: SleepOptions = {}): Promise<void> => new Promise(resolve => {
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
});

const utf8Bytes = (value: unknown): number =>
    new TextEncoder().encode(typeof value === 'string' ? value : '').byteLength;

const backupPayloadBytes = (data: BackupPayloadData | null | undefined): number => {
    let snapshot = '';
    try { snapshot = JSON.stringify(data && data.snapshot ? data.snapshot : null); }
    catch { snapshot = ''; }
    return utf8Bytes(snapshot) + utf8Bytes(data && data.gpx);
};

const createRunner = <T extends BackupRunnerItem = AscentListEntry, TData = BackupPayloadData>({
    ascents,
    existingFolders = [],
    refreshAll = false,
    loadItem,
    pushBatch,
    sleep = cancellableSleep,
    onState = () => {},
    paceMs = 2000,
    retryDelays = [4000, 15000],
    transientPauseAfter = 2,
    batchItems = DEFAULT_BATCH_ITEMS,
    batchBytes = DEFAULT_BATCH_BYTES,
    bufferItems = DEFAULT_BUFFER_ITEMS,
    bufferBytes = DEFAULT_BUFFER_BYTES,
    measureItem = backupPayloadBytes as (data: TData, item: T) => number,
}: CreateRunnerOptions<T, TData> = {} as CreateRunnerOptions<T, TData>): ProfileBackupRunner<T> => {
    if (typeof loadItem !== 'function' || typeof pushBatch !== 'function') {
        throw new TypeError('profile backup runner requires loadItem and pushBatch');
    }
    for (const [name, value] of Object.entries({ batchItems, batchBytes, bufferItems, bufferBytes })) {
        if (!Number.isFinite(value) || value <= 0) throw new TypeError(`profile backup runner requires positive ${name}`);
    }
    if (batchItems > bufferItems || batchBytes > bufferBytes) {
        throw new TypeError('profile backup batch limits must fit inside the buffer limits');
    }
    const { work, skipped } = buildWorkList(ascents, existingFolders, { refreshAll });
    const state: ProfileBackupRunnerState<T> = {
        status: 'idle',
        total: work.length + skipped.length,
        queued: work.length,
        completed: skipped.length,
        backedUp: 0,
        skipped: skipped.length,
        failures: [],
        current: null,
        fetched: 0,
        buffered: 0,
        bufferedBytes: 0,
        uploading: 0,
        producerWaiting: false,
        pauseReason: null,
        pauseError: null,
        pauseBatchSize: 0,
        challengeUrl: null,
        notReached: work.length,
    };
    let nextLoadIndex = 0;
    const buffer: Array<{ item: T; data: TData; bytes: number }> = [];
    let bufferedByteCount = 0;
    let producerDone = false;
    let cancelled = false;
    let pauseRequested = false;
    let challengeProbeUrl: string | null = null;
    let challenged = false;
    let consecutiveTransientFailures = 0;
    let activeRun: Promise<ProfileBackupRunnerState<T>> | null = null;
    let halt: { reason: ProfileBackupPauseReason; patch: Partial<ProfileBackupRunnerState<T>> } | null = null;
    let activeReadController: AbortController | null = null;
    let activeWaitController: AbortController | null = null;
    const waiters = new Set<() => void>();

    const notify = (): void => {
        for (const resolve of waiters) resolve();
        waiters.clear();
    };
    const waitForChange = (): Promise<void> => new Promise(resolve => waiters.add(resolve));

    const publish = (patch: Partial<ProfileBackupRunnerState<T>>): void => {
        Object.assign(state, patch);
        state.buffered = buffer.length;
        state.bufferedBytes = bufferedByteCount;
        state.notReached = Math.max(0, work.length - state.backedUp - state.failures.length);
        onState({ ...state, failures: state.failures.slice() });
    };
    const recordFailure = (item: T, reason: string, kind = 'wrong-content'): void => {
        state.failures.push({ aid: item.aid, peakName: item.peakName || '', ascentUrl: item.ascentUrl || '', reason, kind });
        publish({ completed: state.completed + 1 });
    };
    const safeLoad = async (
        item: T,
        options: { probe: boolean; probeUrl: string | null },
    ): Promise<LoadItemResult<TData> | null | undefined> => {
        const controller = new AbortController();
        activeReadController = controller;
        try { return await loadItem(item, { ...options, signal: controller.signal }); }
        catch (error) { return { kind: 'transient', reason: messageFromError(error) || 'Network request failed.' }; }
        finally {
            if (activeReadController === controller) activeReadController = null;
        }
    };
    const wait = async (ms: number): Promise<boolean> => {
        const controller = new AbortController();
        activeWaitController = controller;
        let resolveInterrupted!: (value: boolean) => void;
        const interrupted = new Promise<boolean>(resolve => { resolveInterrupted = resolve; });
        const interrupt = () => resolveInterrupted(false);
        controller.signal.addEventListener('abort', interrupt, { once: true });
        const delay = Promise.resolve()
            .then(() => sleep(ms, { signal: controller.signal }))
            .then(() => true, () => !controller.signal.aborted);
        try { return await Promise.race([delay, interrupted]); }
        finally {
            controller.signal.removeEventListener('abort', interrupt);
            if (activeWaitController === controller) activeWaitController = null;
        }
    };
    const interruptRetractableWork = (): void => {
        activeReadController?.abort();
        activeWaitController?.abort();
        notify();
    };
    const stopFor = (reason: ProfileBackupPauseReason, patch: Partial<ProfileBackupRunnerState<T>> = {}): void => {
        if (!halt) halt = { reason, patch };
        notify();
    };
    const isBufferFull = (): boolean => buffer.length >= bufferItems || bufferedByteCount >= bufferBytes;
    const nextBatch = (): Array<{ item: T; data: TData; bytes: number }> => {
        const selected: Array<{ item: T; data: TData; bytes: number }> = [];
        let bytes = 0;
        for (const entry of buffer) {
            if (selected.length >= batchItems) break;
            if (selected.length && bytes + entry.bytes > batchBytes) break;
            selected.push(entry);
            bytes += entry.bytes;
        }
        return selected;
    };

    const produce = async (): Promise<void> => {
        while (nextLoadIndex < work.length && !cancelled && !pauseRequested && !halt) {
            while (isBufferFull() && !cancelled && !pauseRequested && !halt) {
                if (!state.producerWaiting) publish({ producerWaiting: true, current: null });
                await waitForChange();
            }
            if (cancelled || pauseRequested || halt) break;

            if (state.producerWaiting) publish({ producerWaiting: false });
            const item = work[nextLoadIndex];
            publish({ current: item });
            let loaded: LoadItemResult<TData> | null | undefined;
            let transientAttempts = 0;
            while (true) {
                loaded = await safeLoad(item, { probe: !!challengeProbeUrl, probeUrl: challengeProbeUrl });
                challengeProbeUrl = null;
                if (cancelled || pauseRequested) break;
                if (loaded && loaded.kind === 'transient' && transientAttempts < retryDelays.length) {
                    const completedWait = await wait(retryDelays[transientAttempts]);
                    transientAttempts += 1;
                    if (!completedWait || cancelled || pauseRequested) break;
                    continue;
                }
                break;
            }

            // A user request aborts retractable reads and discards their result
            // before it can enter a GitHub batch. Challenge/error pauses retain
            // a completed successful fetch in the bounded buffer.
            if (cancelled || pauseRequested) break;

            if (loaded && loaded.kind === 'challenged') {
                challenged = true;
                challengeProbeUrl = ('url' in loaded ? loaded.url : undefined) || item.editUrl || null;
                stopFor('challenge', { challengeUrl: challengeProbeUrl });
            } else if (loaded && loaded.kind === 'transient') {
                consecutiveTransientFailures += 1;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                recordFailure(item, failureReason(loaded), 'transient');
                if (consecutiveTransientFailures >= transientPauseAfter && nextLoadIndex < work.length) {
                    stopFor('transient');
                }
            } else if (!isOkLoadResult(loaded)) {
                consecutiveTransientFailures = 0;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                recordFailure(item, failureReason(loaded));
            } else {
                consecutiveTransientFailures = 0;
                let bytes = Number(measureItem(loaded.data, item));
                if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
                buffer.push({ item, data: loaded.data, bytes });
                bufferedByteCount += bytes;
                nextLoadIndex += 1;
                publish({ fetched: state.fetched + 1, current: null });
                notify();
            }
            if (nextLoadIndex < work.length && !cancelled && !pauseRequested && !halt) {
                await wait(challenged ? paceMs * 2 : paceMs);
            }
        }
        producerDone = nextLoadIndex >= work.length;
        publish({ producerWaiting: false, current: null });
        notify();
    };

    const consume = async (): Promise<void> => {
        while (!cancelled && !pauseRequested && !halt) {
            const ready = buffer.length >= batchItems
                || bufferedByteCount >= batchBytes
                || (producerDone && buffer.length > 0);
            if (!ready) {
                if (producerDone && buffer.length === 0) break;
                await waitForChange();
                continue;
            }

            const batch = nextBatch();
            publish({ uploading: batch.length });
            let pushed: PushBatchResult | null | undefined;
            try { pushed = await pushBatch(batch.map(({ item, data }) => ({ item, data }))); }
            catch (error) { pushed = { ok: false, error: { message: messageFromError(error) } }; }
            if (!pushed || !pushed.ok) {
                const error = pushed && pushed.error;
                const first = batch[0].item;
                publish({ uploading: 0 });
                stopFor('github', {
                    pauseBatchSize: batch.length,
                    pauseError: {
                        aid: first.aid,
                        peakName: first.peakName || '',
                        ascentUrl: first.ascentUrl || '',
                        reason: trim(error && error.message) || trim(error && error.code) || 'GitHub backup failed.',
                        kind: 'github',
                    },
                });
                break;
            }

            buffer.splice(0, batch.length);
            bufferedByteCount = Math.max(0, bufferedByteCount - batch.reduce((sum, entry) => sum + entry.bytes, 0));
            publish({
                uploading: 0,
                completed: state.completed + batch.length,
                backedUp: state.backedUp + batch.length,
            });
            notify();
        }
    };

    const perform = async (): Promise<ProfileBackupRunnerState<T>> => {
        if (cancelled) { publish({ status: 'cancelled', current: null }); return { ...state }; }
        publish({
            status: 'running', pauseReason: null, pauseError: null, pauseBatchSize: 0,
            challengeUrl: null, current: null,
        });
        await Promise.all([produce(), consume()]);
        if (cancelled) publish({ status: 'cancelled', current: null, uploading: 0, producerWaiting: false });
        else if (halt) publish({
            status: 'paused', pauseReason: halt.reason, current: null, uploading: 0,
            producerWaiting: false, ...halt.patch,
        });
        else if (producerDone && buffer.length === 0) publish({ status: 'complete', current: null, notReached: 0 });
        else if (pauseRequested) publish({ status: 'paused', pauseReason: 'user', current: null, uploading: 0, producerWaiting: false });
        return { ...state, failures: state.failures.slice() };
    };

    return {
        state,
        run() {
            if (!activeRun) activeRun = perform().finally(() => { activeRun = null; });
            return activeRun;
        },
        pause() {
            if (!cancelled && state.status === 'running') {
                pauseRequested = true;
                publish({ status: 'pause-requested' });
                interruptRetractableWork();
            }
        },
        resume() {
            if (cancelled || state.status !== 'paused') return Promise.resolve({ ...state });
            pauseRequested = false;
            halt = null;
            return this.run();
        },
        cancel() {
            if (cancelled) return;
            cancelled = true;
            pauseRequested = false;
            interruptRetractableWork();
            if (activeRun) publish({ status: 'cancel-requested' });
            else publish({ status: 'cancelled', current: null });
        },
    };
};

export const profileBackupCore = {
    numericParam,
    ownerClimberId,
    parseAscentList,
    buildWorkList,
    fullListUrl,
    classifyResponse,
    createRunner,
    backupPayloadBytes,
};
