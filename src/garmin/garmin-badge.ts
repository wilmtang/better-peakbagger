// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// The toolbar badge mirrors the inbox queue: activities still waiting for peak
// checks. Capture errors use tab-specific badges, which browsers show in
// preference to this global value, so a warning is never hidden by a count.
const BADGE_COLOR = '#2c6244';
const DEFAULT_TITLE = 'Capture activity for Peakbagger';

export const waitingCountLabel = (count: number) => count > 99 ? '99+' : count > 0 ? String(count) : '';

interface BadgeDependencies {
    ext: Partial<Pick<typeof chrome, 'action' | 'runtime'>>;
    settings: { requireCurrent(): Promise<{ enableGarminInbox: boolean; showInboxToolbarCount: boolean }> };
    summary: () => Promise<{ queued: number }>;
}

export function createGarminBadge({ ext, settings, summary }: BadgeDependencies) {
    let running: Promise<void> | null = null, again = false;
    const apply = async () => {
        const action = ext.action;
        if (!action?.setBadgeText) return;
        const prefs = await settings.requireCurrent();
        const count = prefs.enableGarminInbox && prefs.showInboxToolbarCount ? (await summary()).queued : 0;
        const manifest = ext.runtime?.getManifest?.() as { action?: { default_title?: string } } | undefined;
        const title = manifest?.action?.default_title || DEFAULT_TITLE;
        await action.setBadgeBackgroundColor({ color: BADGE_COLOR });
        await action.setBadgeText({ text: waitingCountLabel(count) });
        await action.setTitle?.({ title: count ? `${title} (${count} waiting for peak checks)` : title });
    };
    // Writes can arrive in bursts. Finish the current pass, then read once more
    // so the badge always settles on the newest queue and preference.
    const sync = (): Promise<void> => {
        if (running) { again = true; return running; }
        running = (async () => {
            do {
                again = false;
                // An unreadable setting or store keeps the last accurate badge.
                try { await apply(); } catch { /* A later write or worker start retries. */ }
            } while (again);
        })().finally(() => { running = null; });
        return running;
    };
    return { sync };
}
