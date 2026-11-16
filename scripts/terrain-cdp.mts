// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The raw Chrome DevTools Protocol plumbing shared by the terrain verifiers,
// which launch Chrome themselves to drive the real extension frame on
// hardware GL: wait for the debugging port, connect over WebSocket, and
// evaluate an expression in a page.

import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// CDP responses are arbitrary protocol JSON, parsed at one boundary below.
export type CdpResult = ReturnType<typeof JSON.parse>;
export interface Cdp { call(method: string, params?: object): Promise<CdpResult>; on(method: string, listener: (params: CdpResult) => void): void; close(): void; }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const waitForDebugPort = async (profile: string, child: ChildProcess, childState: { error?: Error | null; [field: string]: unknown }, timeoutMs = 10000) => {
    const activePortFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (childState.error) throw new Error(`Chrome failed to start: ${childState.error.message}`, {
            cause: childState.error,
        });
        if (child.exitCode !== null) throw new Error(`Chrome exited before opening CDP (${child.exitCode})`);
        try {
            const [port] = (await readFile(activePortFile, 'utf8')).trim().split('\n');
            if (/^\d+$/.test(port)) return Number(port);
        } catch { /* Chrome has not written the port file yet. */ }
        await delay(50);
    }
    throw new Error('Timed out waiting for Chrome DevToolsActivePort');
};

export const connectCdp = async (url: string): Promise<Cdp> => {
    if (typeof WebSocket !== 'function') throw new Error('This verification script requires a Node.js runtime with global WebSocket support');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });

    let nextId = 1;
    const pending = new Map<number, { method: string; resolve(value: CdpResult): void; reject(reason: Error): void }>();
    const listeners = new Map<string, ((params: CdpResult) => void)[]>();
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
            const promise = pending.get(message.id);
            if (!promise) return;
            pending.delete(message.id);
            if (message.error) promise.reject(new Error(`${promise.method}: ${message.error.message}`));
            else promise.resolve(message.result);
            return;
        }
        for (const listener of listeners.get(message.method) || []) listener(message.params);
    });

    return {
        call(method, params = {}) {
            const id = nextId++;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
        },
        on(method, listener) {
            if (!listeners.has(method)) listeners.set(method, []);
            listeners.get(method)!.push(listener);
        },
        close() { socket.close(); }
    };
};

export const evaluate = async (cdp: Cdp, expression: string) => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed');
    return result.result.value;
};
