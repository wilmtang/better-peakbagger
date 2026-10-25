// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Only packaged pages construct workers. No fetch/storage operation is exposed.
export function createCustomParser(workerUrl, WorkerClass = globalThis.Worker) {
    const jobs = new Set(), queue = []; let disposed = false;
    const pump = () => { while (jobs.size < 2 && queue.length) queue.shift()(); };
    const parse = (data, signal) => new Promise((resolve, reject) => {
        let worker = null, timer = null, done = false;
        const finish = (error, value) => {
            if (done) return; done = true;
            clearTimeout(timer); worker?.terminate(); jobs.delete(cancel); signal?.removeEventListener('abort', cancel);
            const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1);
            if (error) reject(error); else resolve(value); pump();
        };
        const cancel = () => finish(new DOMException('Cancelled.', 'AbortError'));
        const start = () => {
            if (disposed || signal?.aborted) { cancel(); return; }
            jobs.add(cancel);
            try {
                worker = new WorkerClass(workerUrl);
                timer = setTimeout(() => finish(new Error('Source decoding took too long.')), 2000);
                worker.onmessage = event => event.data?.ok ? finish(null, event.data.value) : finish(new Error('Invalid or oversized vector data.'));
                worker.onerror = () => finish(new Error('Vector decoder could not start.'));
                worker.postMessage(data, [data.bytes]);
            } catch { finish(new Error('Vector decoder could not start.')); }
        };
        if (disposed || signal?.aborted) { cancel(); return; }
        if (queue.length >= 64) { finish(new Error('Too much vector work. Zoom in.')); return; }
        signal?.addEventListener('abort', cancel, { once: true }); queue.push(start); pump();
    });
    return { parse, dispose() { disposed = true; for (const cancel of [...jobs]) cancel(); for (const start of queue.splice(0)) start(); for (const cancel of [...jobs]) cancel(); } };
}
