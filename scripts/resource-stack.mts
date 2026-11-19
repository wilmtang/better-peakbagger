// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small verifier-only ownership primitive. Resources are registered immediately
// after acquisition and released in reverse order. Every finalizer runs even if
// an earlier one rejects; a product/assertion failure remains the thrown error.

import { spawn, type SpawnOptions } from 'node:child_process';
import type { ListenOptions, Server } from 'node:net';

export interface ResourceStackOptions {
    finalizerTimeoutMs?: number;
}

export interface DeferOptions {
    timeoutMs?: number;
}

export interface ResourceStack {
    defer(label: string, finalizer: () => unknown, options?: DeferOptions): void;
    dispose(primaryError?: unknown): Promise<void>;
    guard<T>(operation: (() => T | PromiseLike<T>) | PromiseLike<T>): Promise<Awaited<T>>;
}

export interface CloseableServer {
    listening?: boolean;
    close(callback?: (error?: Error) => void): unknown;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
}

export type ServerListenArgs =
    | [port?: number, hostname?: string, backlog?: number]
    | [path: string, backlog?: number]
    | [options: ListenOptions];

export interface StopChildProcessOptions {
    graceMs?: number;
}

export interface ManagedChildProcess {
    exitCode: number | null;
    signalCode: string | null;
    pid?: number;
    kill(signal: 'SIGTERM' | 'SIGKILL'): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    once(event: 'exit', listener: () => void): unknown;
    removeListener(event: 'exit', listener: () => void): unknown;
}

export interface ManagedChildState {
    error: Error | null;
}

export interface WebDriverLike {
    quit(): Promise<unknown>;
}

export interface RunChildProcessOptions extends Omit<SpawnOptions, 'stdio'> {
    label?: string;
    stdio?: SpawnOptions['stdio'] | string;
}

interface ResourceFinalizer {
    label: string;
    finalizer: () => unknown;
    timeoutMs: number;
}

const errorMessage = (error: unknown): unknown => {
    if (error && typeof error === 'object' && 'message' in error) {
        return (error as { message?: unknown }).message || error;
    }
    return error;
};

const cleanupFailure = (label: string, error: unknown): Error => new Error(
    `Cleanup failed for ${label}: ${errorMessage(error)}`,
    { cause: error },
);

const settleWithTimeout = async (promise: Promise<unknown>, label: string, timeoutMs: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} did not finish within ${timeoutMs} ms`)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export function createResourceStack({ finalizerTimeoutMs = 10_000 }: ResourceStackOptions = {}): ResourceStack {
    const finalizers: ResourceFinalizer[] = [];
    let disposed = false;

    const stack: ResourceStack = {
        defer(label, finalizer, { timeoutMs = finalizerTimeoutMs } = {}) {
            if (disposed) throw new Error('Cannot register a resource after cleanup started');
            if (typeof finalizer !== 'function') throw new TypeError('Resource finalizer must be a function');
            finalizers.push({ label, finalizer, timeoutMs });
        },

        async dispose(primaryError = null) {
            if (disposed) {
                if (primaryError) throw primaryError;
                return;
            }
            disposed = true;
            const cleanupErrors: Error[] = [];
            while (finalizers.length) {
                const { label, finalizer, timeoutMs } = finalizers.pop()!;
                try {
                    await settleWithTimeout(
                        Promise.resolve().then(finalizer),
                        `${label} cleanup`,
                        timeoutMs,
                    );
                } catch (error) {
                    cleanupErrors.push(cleanupFailure(label, error));
                }
            }

            if (primaryError) {
                if (cleanupErrors.length) {
                    Object.defineProperty(primaryError as object, 'cleanupErrors', {
                        configurable: true,
                        value: cleanupErrors,
                    });
                    (primaryError as { message: string }).message += `\nCleanup also failed:\n${cleanupErrors
                        .map(cleanupError => `- ${cleanupError.message}`)
                        .join('\n')}`;
                }
                throw primaryError;
            }
            if (cleanupErrors.length) {
                throw new AggregateError(
                    cleanupErrors,
                    `One or more verifier resources failed to clean up:\n${cleanupErrors
                        .map(cleanupError => `- ${cleanupError.message}`)
                        .join('\n')}`,
                );
            }
        },

        async guard<T>(operation: (() => T | PromiseLike<T>) | PromiseLike<T>): Promise<Awaited<T>> {
            try {
                return await (typeof operation === 'function' ? operation() : operation);
            } catch (error) {
                await stack.dispose(error);
                return undefined as Awaited<T>;
            }
        },
    };
    return stack;
}

export const closeServer = (server?: CloseableServer | null): Promise<void> => new Promise((resolve, reject) => {
    if (!server?.listening) {
        resolve();
        return;
    }
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
});

export const listenServer = (server: Server, ...listenArguments: ServerListenArgs): Promise<void> => new Promise((resolve, reject) => {
    const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
    };
    const onListening = () => {
        server.removeListener('error', onError);
        resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    (server.listen as (...args: ServerListenArgs) => unknown)(...listenArguments);
});

const waitForChildExit = (child: ManagedChildProcess, timeoutMs: number): Promise<boolean> => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
    }
    const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
    }, timeoutMs);
    const onExit = () => {
        clearTimeout(timer);
        resolve(true);
    };
    child.once('exit', onExit);
});

export async function stopChildProcess(
    child?: ManagedChildProcess | null,
    { graceMs = 2_000 }: StopChildProcessOptions = {},
): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForChildExit(child, graceMs)) return;
    child.kill('SIGKILL');
    if (!await waitForChildExit(child, graceMs)) {
        throw new Error(`Child process ${child.pid ?? '(no pid)'} did not exit after SIGKILL`);
    }
}

export async function quitWebDriver(driver?: WebDriverLike | null): Promise<void> {
    try {
        await driver?.quit();
    } catch (error) {
        if (error && typeof error === 'object' && 'message' in error
            && error.message === 'WebDriver session does not exist, or is not active') return;
        throw error;
    }
}

export function manageChildProcess(
    resources: Pick<ResourceStack, 'defer'>,
    child: ManagedChildProcess,
    label: string,
    options?: StopChildProcessOptions,
): ManagedChildState {
    const state: ManagedChildState = { error: null };
    // Attach before the caller can await startup. A failed spawn otherwise emits
    // an unhandled `error` event and bypasses every surrounding cleanup scope.
    child.on('error', error => { state.error = error; });
    resources.defer(label, () => stopChildProcess(child, options));
    return state;
}

export async function runChildProcess(
    command: string,
    args: readonly string[] = [],
    { label = command, ...options }: RunChildProcessOptions = {},
): Promise<void> {
    const resources = createResourceStack();
    await resources.guard(() => new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options } as SpawnOptions);
        manageChildProcess(resources, child, label);
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 && !signal
            ? resolve() : reject(new Error(`${label} failed (${signal || `exit ${code}`})`)));
    }));
    await resources.dispose();
}
