/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */

export type PeakPopupSnapshot =
    | { replaced: false; name: string | null; href: string }
    | { replaced: true; name: string | null; href: string | null };

export interface PeakPopupSnapshotPage {
    waitForFunction<R>(pageFunction: () => R): Promise<{
        jsonValue(): Promise<R>;
        dispose(): Promise<void>;
    }>;
}

interface TerrainFrameWindow {
    document: Document;
    __bpbPeakNameMarker: Element;
}

export function peakPopupSnapshot(): PeakPopupSnapshot | false {
    const win = (document.getElementById('bpb-terrain-frame') as HTMLIFrameElement).contentWindow as unknown as TerrainFrameWindow;
    const link = win.document.querySelector('.bpb-peak-popup a');
    const replaced = !win.__bpbPeakNameMarker.isConnected;
    return (link || replaced ? { replaced, name: link?.textContent ?? null, href: link?.getAttribute('href') ?? null } : false) as PeakPopupSnapshot | false;
}

export async function waitForPeakPopupSnapshot(page: PeakPopupSnapshotPage): Promise<PeakPopupSnapshot> {
    // Keep readiness and identity in one browser task: marker reconciliation
    // can close the popup before a later locator command reads its contents.
    const handle = await page.waitForFunction(peakPopupSnapshot);
    try { return await handle.jsonValue() as PeakPopupSnapshot; }
    finally { await handle.dispose(); }
}
