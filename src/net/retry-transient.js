// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const temporaryHttpStatus = status => [408, 500, 502, 503, 504].includes(status);

// One cancelled-aware retry. Validation failures, permissions and rate-limit
// deadlines remain the caller's responsibility and are never inferred as safe.
export async function retryTransient(work, { signal, delayMs = 350 } = {}) {
    try { return await work(); }
    catch (error) {
        if (signal?.aborted || error.code === 'rate-limit' || !(error.transient || error.name === 'TimeoutError' || error instanceof TypeError)) throw error;
        await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled.', 'AbortError')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
        return work();
    }
}
