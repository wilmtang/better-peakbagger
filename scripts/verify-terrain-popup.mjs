// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */

export function peakPopupSnapshot() {
    const win = document.getElementById('bpb-terrain-frame').contentWindow;
    const link = win.document.querySelector('.bpb-peak-popup a');
    const replaced = !win.__bpbPeakNameMarker.isConnected;
    return link || replaced ? { replaced, name: link?.textContent ?? null, href: link?.getAttribute('href') ?? null } : false;
}

export async function waitForPeakPopupSnapshot(page) {
    // Keep readiness and identity in one browser task: marker reconciliation
    // can close the popup before a later locator command reads its contents.
    const handle = await page.waitForFunction(peakPopupSnapshot);
    try { return await handle.jsonValue(); }
    finally { await handle.dispose(); }
}
