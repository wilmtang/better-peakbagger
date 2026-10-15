// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createResourceStack } from './resource-stack.mjs';

export async function setFirefoxContentViewport(driver, viewport) {
    const label = viewport ? `${viewport.width}x${viewport.height}` : 'reset';
    try {
        const response = await (await driver.getBidi()).send({
            method: 'browsingContext.setViewport',
            params: { context: await driver.getWindowHandle(), viewport },
        });
        if (response.type === 'error') throw new Error(`${response.error}: ${response.message}`);
    } catch (error) {
        throw new Error(`Firefox browsingContext.setViewport ${label} failed: ${error.message}`, { cause: error });
    }
}

export async function withFirefoxContentViewport(driver, operation) {
    const resources = createResourceStack();
    // BiDi already has a 30-second transport deadline. Preserve the assertion
    // that caused cleanup even if resetting the browser also times out.
    resources.defer('Firefox content viewport', () => setFirefoxContentViewport(driver, null), { timeoutMs: 35_000 });
    const result = await resources.guard(operation);
    await resources.dispose();
    return result;
}
