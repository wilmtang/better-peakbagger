// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createResourceStack } from './resource-stack.mts';

export interface FirefoxViewport {
    width: number;
    height: number;
}

export interface FirefoxBidiDriver {
    getWindowHandle(): Promise<string>;
    getBidi(): Promise<{
        send(request: { method: string; params: Record<string, unknown> }): Promise<unknown>;
    }>;
}

export async function setFirefoxContentViewport(
    driver: FirefoxBidiDriver,
    viewport: FirefoxViewport | null,
): Promise<void> {
    const label = viewport ? `${viewport.width}x${viewport.height}` : 'reset';
    try {
        const response = await (await driver.getBidi()).send({
            method: 'browsingContext.setViewport',
            params: { context: await driver.getWindowHandle(), viewport },
        }) as { type?: string; error?: string; message?: string } | null | undefined;
        if (response?.type === 'error') throw new Error(`${response.error}: ${response.message}`);
        if (response?.type !== 'success') throw new Error('missing or invalid BiDi reply');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Firefox browsingContext.setViewport ${label} failed: ${message}`, { cause: error });
    }
}

export async function withFirefoxContentViewport<T>(
    driver: FirefoxBidiDriver,
    operation: (() => Promise<T> | T) | Promise<T>,
): Promise<T> {
    const resources = createResourceStack();
    // BiDi already has a 30-second transport deadline. Preserve the assertion
    // that caused cleanup even if resetting the browser also times out.
    resources.defer('Firefox content viewport', () => setFirefoxContentViewport(driver, null), { timeoutMs: 35_000 });
    const result = await resources.guard(operation);
    await resources.dispose();
    return result as T;
}
