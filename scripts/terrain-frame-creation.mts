/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from 'playwright';

declare global {
    interface Window {
        __bpbTerrainFrameCreation?: { created: boolean; observer: MutationObserver };
    }
}

// Arm before the trusted gesture: deliberately blocked providers can remove a
// correctly inserted frame before a later selector poll starts. These probes
// establish bridge insertion only, never successful terrain rendering.
export function installTerrainFrameCreation(expectedUrl: string) {
    const mount = document.getElementById('bpb-map-viewport');
    if (!mount?.isConnected) throw new Error('Terrain frame probe requires the connected viewport');
    window.__bpbTerrainFrameCreation?.observer.disconnect();
    const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
            if (mount.isConnected && record.target === mount && node instanceof HTMLIFrameElement
                && node.id === 'bpb-terrain-frame' && node.src === expectedUrl) {
                window.__bpbTerrainFrameCreation!.created = true;
                observer.disconnect();
                return;
            }
        }
    });
    window.__bpbTerrainFrameCreation = { created: false, observer };
    observer.observe(mount, { childList: true });
}

export function readTerrainFrameCreation() {
    return window.__bpbTerrainFrameCreation?.created === true;
}

export function stopTerrainFrameCreation() {
    window.__bpbTerrainFrameCreation?.observer.disconnect();
    delete window.__bpbTerrainFrameCreation;
}

export async function observeTerrainFrameCreation<T>(page: Page, expectedUrl: string, action: () => Promise<T>) {
    await page.evaluate(installTerrainFrameCreation, expectedUrl);
    let failure: { error: unknown } | undefined;
    try {
        const value = await action();
        // Preserve the existing three-second post-init bound. The durable
        // insertion record cannot disappear when the frame handles an error.
        const created = await page.waitForFunction(readTerrainFrameCreation, null, { timeout: 3000 })
            .then(() => true).catch(() => false);
        return { value, created };
    } catch (error) {
        failure = { error };
        throw error;
    } finally {
        try { await page.evaluate(stopTerrainFrameCreation); }
        catch (error) {
            if (failure) throw new AggregateError([failure.error, error], 'Terrain frame observation and cleanup failed');
            throw error;
        }
    }
}
