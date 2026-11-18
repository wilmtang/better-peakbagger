// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CustomGeoJsonCollection, CustomMvtResult, CustomParseRequest } from './custom-overlay-data.ts';

export type CustomParseResult = CustomGeoJsonCollection | CustomMvtResult;

export type CustomParserWorker = Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;
export type CustomParserWorkerConstructor = new (scriptURL: string | URL) => CustomParserWorker;

export interface CustomParser {
    parse(data: CustomParseRequest, signal?: AbortSignal | null): Promise<CustomParseResult>;
    dispose(): void;
}

// Only packaged pages construct workers. No fetch/storage operation is exposed.
export function createCustomParser(
    workerUrl: string | URL,
    WorkerClass: CustomParserWorkerConstructor = globalThis.Worker,
): CustomParser {
    const jobs = new Set<() => void>();
    const queue: Array<() => void> = [];
    let disposed = false;
    const pump = () => {
        while (jobs.size < 2 && queue.length) queue.shift()!();
    };
    const parse = (data: CustomParseRequest, signal?: AbortSignal | null): Promise<CustomParseResult> => new Promise((resolve, reject) => {
        let worker: CustomParserWorker | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = (error: unknown, value?: CustomParseResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            worker?.terminate();
            jobs.delete(cancel);
            signal?.removeEventListener('abort', cancel);
            const index = queue.indexOf(start);
            if (index >= 0) queue.splice(index, 1);
            if (error) reject(error);
            else resolve(value as CustomParseResult);
            pump();
        };
        const cancel = () => finish(new DOMException('Cancelled.', 'AbortError'));
        const start = () => {
            if (disposed || signal?.aborted) { cancel(); return; }
            jobs.add(cancel);
            try {
                worker = new WorkerClass(workerUrl);
                timer = setTimeout(() => finish(new Error('Source decoding took too long.')), 2000);
                worker.onmessage = event => {
                    const reply = event.data as { ok?: boolean; value?: CustomParseResult } | null | undefined;
                    if (reply?.ok) finish(null, reply.value);
                    else finish(new Error('Invalid or oversized vector data.'));
                };
                worker.onerror = () => finish(new Error('Vector decoder could not start.'));
                worker.postMessage(data, [data.bytes]);
            } catch { finish(new Error('Vector decoder could not start.')); }
        };
        if (disposed || signal?.aborted) { cancel(); return; }
        if (queue.length >= 64) { finish(new Error('Too much vector work. Zoom in.')); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        queue.push(start);
        pump();
    });
    return {
        parse,
        dispose() {
            disposed = true;
            for (const cancel of [...jobs]) cancel();
            for (const start of queue.splice(0)) start();
            for (const cancel of [...jobs]) cancel();
        },
    };
}
