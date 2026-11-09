// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const temporaryHttpStatus = (status: number) => [408, 500, 502, 503, 504].includes(status);

// One cancelled-aware retry. Validation failures, permissions and rate-limit
// deadlines remain the caller's responsibility and are never inferred as safe.
export async function retryTransient<T>(work: () => T | Promise<T>, { signal, delayMs = 350 }: {signal?: AbortSignal; delayMs?: number} = {}): Promise<T> {
    try { return await work(); }
    catch (error) {
        const failure = error && typeof error === 'object' ? error as {code?: unknown; transient?: unknown; name?: unknown} : undefined;
        // A parent-owned map controller calls the embedded window's fetch.
        // Its native rejection is a TypeError from that window's realm.
        if (signal?.aborted || failure?.code === 'rate-limit' || !(failure?.transient || failure?.name === 'TimeoutError'
            || error instanceof TypeError || failure?.name === 'TypeError')) throw error;
        await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled.', 'AbortError')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
        return work();
    }
}
