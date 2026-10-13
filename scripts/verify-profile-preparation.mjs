// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, innerWidth */
import assert from 'node:assert/strict';

export async function verifyProfilePreparation({ evaluate, wait, click, key, resize, screenshot, readStarted, readAborted }) {
    await wait(() => document.querySelector('#bpb-profile-backup .bpb-profile-primary'));
    await click('#bpb-profile-backup .bpb-profile-primary');
    await wait(() => document.querySelector('#bpb-profile-backup')?.textContent.includes('Preparing backup')
        && document.querySelector('#bpb-profile-backup button:not(:disabled)')?.textContent === 'Cancel');
    await readStarted();
    for (const [width, theme] of [[1000, 'light'], [375, 'dark']]) {
        await resize(width, 760);
        await evaluate(theme === 'dark' ? () => { document.documentElement.dataset.bpbTheme = 'dark'; }
            : () => { document.documentElement.dataset.bpbTheme = 'light'; });
        const geometry = await evaluate(() => {
            const panel = document.getElementById('bpb-profile-backup'), rect = panel.getBoundingClientRect();
            return { left: rect.left, right: rect.right, viewport: innerWidth,
                overflow: panel.scrollWidth > panel.clientWidth + 1 };
        });
        assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport && !geometry.overflow, JSON.stringify(geometry));
        await screenshot?.(`preparing-${width}-${theme}`);
    }
    await evaluate(() => document.querySelector('#bpb-profile-backup button:not(:disabled)').focus());
    await key('#bpb-profile-backup button:not(:disabled)', 'Enter');
    await wait(() => document.querySelector('#bpb-profile-backup .bpb-profile-primary')?.textContent === 'Back up all ascents and TRs');
    await readAborted();
    assert.equal(await evaluate(() => document.activeElement === document.querySelector('#bpb-profile-backup .bpb-profile-primary')), true);
    assert.equal(await evaluate(() => document.getElementById('bpb-profile-backup').getAttribute('aria-busy')), 'false');
}
