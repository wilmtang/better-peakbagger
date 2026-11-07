// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, PAGE_FIXTURES } from '../helpers/load-page.mjs';
import { editorReady, modeButton } from '../helpers/report-editor-helpers.mjs';

// A climber biography has no trip report photos, so the standalone Photo
// Topos button never appears there, in any mode.
test('the profile biography editor never shows the Photo Topos button', async t => {
    const dom = await loadPage('climber-climberedit.html', {
        url: 'https://www.peakbagger.com/climber/climberedit.aspx?cid=900001',
        fixtures: PAGE_FIXTURES,
        bundles: ['content/theme.js', 'vendor/marked.umd.js', 'content/profile-editor.js'],
    } as never) as { window: Window & typeof globalThis };
    t.after(() => dom.window.close());
    const ui = await editorReady(dom as never) as HTMLElement;
    const launch = ui.querySelector<HTMLButtonElement>('.bpb-re-topo-launch');
    for (const label of ['Markdown', 'Plain', 'Rich text']) {
        (modeButton(dom.window.document as never, label) as HTMLButtonElement | undefined)?.click();
        assert.equal(launch?.hidden ?? true, true, `${label}: no Photo Topos button on a profile`);
    }
});
