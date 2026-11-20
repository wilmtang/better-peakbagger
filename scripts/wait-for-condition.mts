// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Polls a read until it is ready, reporting the last value or error on
// timeout. Dependency-free, so verifiers and their browser tests share it.

export interface WaitForConditionOptions<T> {
    description?: string;
    intervalMs?: number;
    timeoutMs?: number;
    isReady?: (value: T) => unknown;
}

export function waitForCondition<T>(
    read: () => T | Promise<T>,
    options: WaitForConditionOptions<T> & { isReady: (value: T) => unknown },
): Promise<T>;
export function waitForCondition<T>(
    read: () => T | Promise<T>,
    options?: WaitForConditionOptions<T>,
): Promise<Exclude<T, false | null | undefined | 0 | ''>>;
export async function waitForCondition<T>(
    read: () => T | Promise<T>,
    {
        description = 'condition',
        intervalMs = 100,
        timeoutMs = 10_000,
        isReady = Boolean,
    }: WaitForConditionOptions<T> = {},
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastValue: T | undefined;
    let lastError: unknown;
    while (Date.now() <= deadline) {
        try {
            lastValue = await read();
            lastError = undefined;
            if (isReady(lastValue)) return lastValue;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    const detail = lastError
        ? `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `last value: ${JSON.stringify(lastValue)}`;
    throw new Error(`Timed out waiting for ${description} (${detail})`);
}
