// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { loadOptions } from '../helpers/options-helpers.mjs';

// Tabs, icon controls, repository pickers and canvas tools have their own
// interaction shapes. Ordinary actions must not invent another button style.
const actions = '.primary, .secondary, .primary-button, .secondary-button, .github-primary, '
    + '.file-button, .quiet-button, .danger-button, .settings-backup-confirm, '
    + '.photos-restore-confirm, .favorites-mirror-confirm, .favorite-undo, .draft-undo';
const specialized = '.status-dismiss, .settings-button, .icon-button, .tab-button, [role="tab"], '
    + '.favorites-source-filter button, .tool-rail button, .view-controls button, #reset-viewport, '
    + '.order-grip, .github-code, .github-repo';
const assertSharedButtons = (doc, surface) => {
    const controls = [...doc.querySelectorAll(`button, ${actions}`)].filter(control => !control.matches(specialized));
    assert(controls.length > 0, `${surface} must exercise action controls`);
    for (const control of controls) assert(control.classList.contains('panel-button'),
        `${surface}: ${control.id || control.getAttribute('aria-label') || control.textContent.trim()} must use the shared action component`);
};

test('all panel action markup uses the shared button component', async () => {
    for (const file of ['options/options.html', 'options/inbox.html', 'options/drafts.html',
        'options/favorites.html', 'popup/popup.html', 'photos/photos.html']) {
        const dom = new JSDOM(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
        try { assertSharedButtons(dom.window.document, file); } finally { dom.window.close(); }
    }
});

test('dynamically rendered Garmin and GitHub settings use the same action component', async () => {
    const dom = await loadOptions({});
    try {
        assert(dom.window.document.querySelector('#garmin-connect'));
        assert(dom.window.document.querySelector('.github-primary'));
        assertSharedButtons(dom.window.document, 'rendered settings');
    } finally { dom.window.close(); }
});
