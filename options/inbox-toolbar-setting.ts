// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const element = <Type extends HTMLElement>(id: string) => document.getElementById(id) as Type;
const input = element<HTMLInputElement>('show-inbox-toolbar-count');
const { flash } = OptionsUtils.createStatusFlash({
    statusEl: element('status'), statusErrorEl: element('status-error'),
    statusErrorTextEl: element('status-error-text'), statusErrorDismissEl: element('status-error-dismiss'),
});
const apply = (settings: { enableGarminInbox: boolean; showInboxToolbarCount: boolean }) => {
    input.checked = settings.showInboxToolbarCount;
    // Disabled rather than hidden: the master switch above must not move this page.
    input.disabled = !settings.enableGarminInbox;
};
void Settings.requireCurrent().then(apply).catch(() => { input.disabled = true; });
const unsubscribe = Settings.subscribe(apply);
addEventListener('pagehide', unsubscribe, { once: true });
input.addEventListener('change', () => {
    const chosen = input.checked;
    void Settings.set({ showInboxToolbarCount: chosen }).then(saved => { apply(saved); flash(); }).catch(() => {
        input.checked = !chosen;
        flash('Settings couldn’t be saved. Try again.', { error: true });
    });
});
