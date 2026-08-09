// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small verifier-only ownership primitive. Resources are registered immediately
// after acquisition and released in reverse order. Every finalizer runs even if
// an earlier one rejects; a product/assertion failure remains the thrown error.

const cleanupFailure = (label, error) => new Error(
    `Cleanup failed for ${label}: ${error?.message || error}`,
    { cause: error },
);

const settleWithTimeout = async (promise, label, timeoutMs) => {
    let timer;
    try {
        await Promise.race([
            promise,
            new Promise((resolve, reject) => {
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

export function createResourceStack({ finalizerTimeoutMs = 10_000 } = {}) {
    const finalizers = [];
    let disposed = false;

    const stack = {
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
            const cleanupErrors = [];
            while (finalizers.length) {
                const { label, finalizer, timeoutMs } = finalizers.pop();
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
                    Object.defineProperty(primaryError, 'cleanupErrors', {
                        configurable: true,
                        value: cleanupErrors,
                    });
                    primaryError.message += `\nCleanup also failed:\n${cleanupErrors
                        .map(error => `- ${error.message}`)
                        .join('\n')}`;
                }
                throw primaryError;
            }
            if (cleanupErrors.length) {
                throw new AggregateError(
                    cleanupErrors,
                    `One or more verifier resources failed to clean up:\n${cleanupErrors
                        .map(error => `- ${error.message}`)
                        .join('\n')}`,
                );
            }
        },

        async guard(operation) {
            try {
                return await (typeof operation === 'function' ? operation() : operation);
            } catch (error) {
                await stack.dispose(error);
            }
        },
    };
    return stack;
}

export const closeServer = server => new Promise((resolve, reject) => {
    if (!server?.listening) {
        resolve();
        return;
    }
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
});

export const listenServer = (server, ...listenArguments) => new Promise((resolve, reject) => {
    const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
    };
    const onListening = () => {
        server.removeListener('error', onError);
        resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(...listenArguments);
});

const waitForChildExit = (child, timeoutMs) => new Promise(resolve => {
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

export async function stopChildProcess(child, { graceMs = 2_000 } = {}) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForChildExit(child, graceMs)) return;
    child.kill('SIGKILL');
    if (!await waitForChildExit(child, graceMs)) {
        throw new Error(`Child process ${child.pid ?? '(no pid)'} did not exit after SIGKILL`);
    }
}

export function manageChildProcess(resources, child, label, options) {
    const state = { error: null };
    // Attach before the caller can await startup. A failed spawn otherwise emits
    // an unhandled `error` event and bypasses every surrounding cleanup scope.
    child.on('error', error => { state.error = error; });
    resources.defer(label, () => stopChildProcess(child, options));
    return state;
}
