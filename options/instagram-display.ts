// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { INSTAGRAM_DISPLAY_ORIGINS } from '../src/reports/instagram-display-registration.ts';
import type { FlashOptions } from './options-utils.ts';

export interface InstagramDisplayOptions {
    extensionApi: typeof chrome;
    flash: (msg?: string, options?: FlashOptions) => unknown;
}

interface InstagramSyncReply {
    ok?: boolean;
}

const errorMessage = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : '';

export function initInstagramDisplay({ extensionApi: api, flash }: InstagramDisplayOptions): void {
    const control = document.getElementById('instagram-display-fixes') as HTMLInputElement | null;
    if (!control || !api?.permissions?.contains) return;
    let busy = false;
    let revision = 0;
    const refresh = async (): Promise<void> => {
        const current = ++revision;
        try {
            const allowed = await api.permissions.contains({ origins: INSTAGRAM_DISPLAY_ORIGINS });
            if (current === revision && !busy) control.checked = allowed;
        } catch {
            if (current === revision && !busy) control.checked = false;
        }
    };
    control.addEventListener('click', event => {
        if (busy) event.preventDefault();
    });
    control.addEventListener('keydown', event => {
        if (busy && (event.key === ' ' || event.key === 'Enter')) event.preventDefault();
    });
    control.addEventListener('change', async () => {
        if (busy) return;
        busy = true;
        revision++;
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('aria-busy', 'true');
        try {
            // Request directly from this explicit user action, before any await.
            const enable = control.checked;
            const changed = enable
                ? await api.permissions.request({ origins: INSTAGRAM_DISPLAY_ORIGINS })
                : await api.permissions.remove({ origins: INSTAGRAM_DISPLAY_ORIGINS });
            if (!changed) {
                flash(enable ? 'Instagram access wasn’t granted.' : 'Instagram access could not be removed.', { error: true });
                return;
            }
            const reply = await api.runtime.sendMessage<Record<string, unknown>, InstagramSyncReply | undefined>({
                type: 'INSTAGRAM_DISPLAY_SYNC',
            });
            if (!reply?.ok) throw new Error('Instagram theme could not be updated. Reload the post to retry.');
            flash(enable ? 'Instagram theme enabled. Reload an open post to apply it.' : 'Instagram theme disabled.');
        } catch (error) {
            flash(errorMessage(error) || 'Instagram access could not be changed.', { error: true });
        } finally {
            busy = false;
            control.removeAttribute('aria-busy');
            control.setAttribute('aria-disabled', 'false');
            void refresh();
        }
    });
    api.permissions.onAdded?.addListener(refresh);
    api.permissions.onRemoved?.addListener(refresh);
    void refresh();
}
