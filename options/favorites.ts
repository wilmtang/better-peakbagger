// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — Favorite climbers settings manager.

import {
    favoriteClimbers as F,
    type BuddyCache,
    type BuddyEntry,
    type FavoriteClimberEntry,
    type FavoriteClimbersList,
    type FavoriteSourceKind,
} from '../src/favorites/favorite-climbers.ts';
import { beginBuddyCacheRead, publishBuddyCache } from '../src/favorites/buddy-cache.ts';
import { peakbaggerError as PeakbaggerError } from '../src/peakbagger/peakbagger-error.ts';
import { isPeakbaggerPageOrigin, PEAKBAGGER_HOSTS, PEAKBAGGER_ORIGIN } from '../src/peakbagger/peakbagger-origin.ts';
import { fetchPeakbaggerDocument } from '../src/peakbagger/peakbagger-request.ts';
import { numericParam, ownerClimberId } from '../src/profile/profile-backup-core.ts';
import { runtimeMessage as RuntimeMessage, type RuntimeMessageResponse } from '../src/ui/runtime-message.ts';
import type { SettingsData } from '../src/settings/settings.ts';
import { optionsUtils as OptionsUtils } from './options-utils.ts';

const UNDO_MS = 6000;
// Covers the helper tab's whole round trip: a blank tab, an extension-helper
// navigation, Peakbagger's own Buddy List over the network, then the content
// script that writes the cache. Measured at ~5.2s (5138–5379ms over 10 runs,
// including under heavy machine load), so this is roughly 1.5x headroom. See
// docs/verify-extension-load-flake.md before changing it — a previous attempt
// replaced it with a progress-extended budget on the assumption it was firing,
// which measurement showed it was not.
const SITE_TAB_REFRESH_MS = 8000;
const SOURCE_FILTERS = ['all', 'buddy', 'manual'] as const;

type FavoritesSource = 'buddies' | 'custom';
type FavoritesSourceFilter = (typeof SOURCE_FILTERS)[number];

export interface FavoritesFlashOptions {
    error?: boolean;
}

export interface InitFavoritesOptions {
    extensionApi?: typeof chrome;
    flash?: (message?: string, options?: FavoritesFlashOptions) => number | void;
    dismissStatus?: (expectedToken?: number) => boolean | void;
    save?: (patch: Partial<SettingsData>) => Promise<unknown>;
}

export interface FavoritesController {
    populate(settings?: Partial<SettingsData> | null): void;
}

interface BuddyFailureState {
    ownerCid: number | null;
    fetchedAt: number;
    failedAt: number;
}

interface PendingDelete {
    entry: FavoriteClimberEntry;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
}

interface PendingBulkReplacement {
    snapshot: FavoriteClimbersList;
    message: string;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    appliedSignature: string | undefined;
}

interface PendingReplacementState {
    replacement: FavoriteClimbersList;
    favoritesSignature: string;
    added: number;
    removed: number;
}

interface FavoritesMutateResponse extends RuntimeMessageResponse {
    ok?: boolean;
    favorites?: FavoriteClimbersList;
    signature?: string;
    details?: {
        added?: number;
        removed?: number;
        skipped?: number;
    };
    error?: {
        code?: string;
        message?: string;
    };
}

interface BuddyPageReadResponse {
    url?: string;
    cache?: {
        entries?: unknown;
        [key: string]: unknown;
    } | null;
}

interface CompletionSummaryCounts {
    added: number;
    removed: number;
    total: number;
    skipped?: number;
}

export const initFavorites = ({
    extensionApi,
    flash = () => 0,
    dismissStatus,
    save = async () => {},
}: InitFavoritesOptions = {}): FavoritesController => {
    const store = extensionApi?.storage?.local;
    const sourceEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="favorites-source"]'));
    const buddyPanelEl = document.getElementById('favorites-buddy-panel') as HTMLElement;
    const customPanelEl = document.getElementById('favorites-custom-panel') as HTMLElement;
    const buddyStatusEl = document.getElementById('favorites-buddy-status') as HTMLElement;
    const refreshBuddiesEl = document.getElementById('favorites-refresh-buddies') as HTMLButtonElement;
    const addFormEl = document.getElementById('favorites-add-form') as HTMLFormElement;
    const addInputEl = document.getElementById('favorites-add-input') as HTMLInputElement;
    const addButtonEl = document.getElementById('favorites-add-button') as HTMLButtonElement;
    const limitEl = document.getElementById('favorites-limit') as HTMLElement;
    const sortEl = document.getElementById('favorites-sort') as HTMLSelectElement;
    const searchEl = document.getElementById('favorites-search') as HTMLInputElement;
    const sourceFilterEls = SOURCE_FILTERS.map(value =>
        document.querySelector(`[data-favorites-source-filter="${value}"]`) as HTMLButtonElement);
    const countEl = document.getElementById('favorites-count') as HTMLElement;
    const mergeEl = document.getElementById('favorites-merge-buddies') as HTMLButtonElement;
    const mirrorEl = document.getElementById('favorites-mirror-buddies') as HTMLButtonElement;
    const removeWithBuddyEl = document.getElementById('favorites-remove-with-buddy') as HTMLInputElement;
    const importStatusEl = document.getElementById('favorites-import-status') as HTMLElement;
    const mirrorConfirmationEl = document.getElementById('favorites-mirror-confirmation') as HTMLElement;
    const mirrorConfirmationTitleEl = document.getElementById('favorites-mirror-confirmation-title') as HTMLElement;
    const mirrorConfirmationImpactEl = document.getElementById('favorites-mirror-confirmation-impact') as HTMLElement;
    const mirrorConfirmationSummaryEl = document.getElementById('favorites-mirror-confirmation-summary') as HTMLElement;
    const mirrorCancelEl = document.getElementById('favorites-mirror-cancel') as HTMLButtonElement;
    const mirrorConfirmEl = document.getElementById('favorites-mirror-confirm') as HTMLButtonElement;
    const emptyEl = document.getElementById('favorites-empty') as HTMLElement;
    const listEl = document.getElementById('favorites-list') as HTMLElement;
    const undoAllEl = document.getElementById('favorites-undo-all') as HTMLElement;
    const undoMessageEl = document.getElementById('favorites-undo-message') as HTMLElement;
    const undoAllButtonEl = document.getElementById('favorites-undo-all-button') as HTMLButtonElement;

    if (!extensionApi || !store || OptionsUtils.logMissingElements('favorite climbers', {
        'input[name="favorites-source"]': sourceEls,
        'favorites-buddy-panel': buddyPanelEl,
        'favorites-custom-panel': customPanelEl,
        'favorites-buddy-status': buddyStatusEl,
        'favorites-refresh-buddies': refreshBuddiesEl,
        'favorites-add-form': addFormEl,
        'favorites-add-input': addInputEl,
        'favorites-add-button': addButtonEl,
        'favorites-limit': limitEl,
        'favorites-sort': sortEl,
        'favorites-search': searchEl,
        '[data-favorites-source-filter]': sourceFilterEls,
        'favorites-count': countEl,
        'favorites-merge-buddies': mergeEl,
        'favorites-mirror-buddies': mirrorEl,
        'favorites-remove-with-buddy': removeWithBuddyEl,
        'favorites-import-status': importStatusEl,
        'favorites-mirror-confirmation': mirrorConfirmationEl,
        'favorites-mirror-confirmation-title': mirrorConfirmationTitleEl,
        'favorites-mirror-confirmation-impact': mirrorConfirmationImpactEl,
        'favorites-mirror-confirmation-summary': mirrorConfirmationSummaryEl,
        'favorites-mirror-cancel': mirrorCancelEl,
        'favorites-mirror-confirm': mirrorConfirmEl,
        'favorites-empty': emptyEl,
        'favorites-list': listEl,
        'favorites-undo-all': undoAllEl,
        'favorites-undo-message': undoMessageEl,
        'favorites-undo-all-button': undoAllButtonEl,
    })) return { populate() {} };

    limitEl.textContent = F.LIMIT.toLocaleString('en-US');

    let source: FavoritesSource = 'buddies';
    let sourceFilter: FavoritesSourceFilter = 'all';
    let favorites: FavoriteClimbersList = F.cleanFavorites(null);
    let buddyCache: BuddyCache | null = null;
    let buddyState: 'idle' | 'loading' = 'idle';
    let buddyError: unknown = null;
    let buddyFailure: BuddyFailureState | null = null;
    let buddyErrorFlashToken: number | null = null;
    let importBuddyError: unknown = null;
    let buddyOrigin = PEAKBAGGER_ORIGIN;
    let refreshPromise: Promise<BuddyCache | null> | null = null;
    let refreshRevision = 0;
    let refreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let pendingBulk: PendingBulkReplacement | null = null;
    let pendingReplacement: PendingReplacementState | null = null;
    let replacementBusy = false;
    const pendingDeletes = new Map<number, PendingDelete>();

    const send = RuntimeMessage.bind(extensionApi);

    const relativeAge = (fetchedAt: number): string => {
        const elapsed = Math.max(0, Date.now() - fetchedAt);
        const minutes = Math.floor(elapsed / 60000);
        if (minutes < 1) return 'updated just now';
        if (minutes < 60) return `updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        return `updated ${days} day${days === 1 ? '' : 's'} ago`;
    };

    const setBusy = (busy: boolean): void => {
        refreshBuddiesEl.disabled = busy;
        mergeEl.disabled = busy;
        mirrorEl.disabled = busy;
    };

    const appendPeakbaggerLink = (target: HTMLElement, {
        label = 'Open Buddy List',
        href = F.signedInBuddyListUrl(PEAKBAGGER_ORIGIN),
    }: { label?: string; href?: string | null } = {}): void => {
        const link = document.createElement('a');
        link.href = href ?? '';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = label;
        target.append(' ', link);
    };

    const appendBuddyRecovery = (error: unknown, target: HTMLElement = buddyStatusEl): void => {
        const recovery = PeakbaggerError.recovery(error, {
            url: F.signedInBuddyListUrl(buddyOrigin) ?? undefined,
            label: 'Open Buddy List',
        });
        if (recovery) appendPeakbaggerLink(target, recovery);
    };

    const renderImportStatus = (message = '', error: unknown = null): void => {
        importBuddyError = error;
        importStatusEl.textContent = message;
        importStatusEl.hidden = !message;
        if (message && error) appendBuddyRecovery(error, importStatusEl);
    };

    const flashBuddyError = (): void => {
        const token = flash(PeakbaggerError.message(buddyError), { error: true });
        buddyErrorFlashToken = typeof token === 'number' ? token : null;
    };

    const acceptBuddyCache = (raw: unknown): void => {
        const next = F.cleanBuddyCache(raw);
        const rawEntries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null;
        if (next && buddyFailure && Array.isArray(rawEntries) && next.entries.length === rawEntries.length
            && (buddyFailure.ownerCid == null || next.ownerCid === buddyFailure.ownerCid)
            && next.fetchedAt > buddyFailure.fetchedAt && next.fetchedAt >= buddyFailure.failedAt) {
            const recoveredError = buddyError;
            buddyError = null;
            buddyFailure = null;
            if (buddyErrorFlashToken != null) dismissStatus?.(buddyErrorFlashToken);
            buddyErrorFlashToken = null;
            if (importBuddyError === recoveredError) renderImportStatus();
        }
        buddyCache = next;
    };

    const favoritesSignature = (): string => F.backupSignature(favorites);

    const completionCopy = (operation: string, { added, removed, total, skipped = 0 }: CompletionSummaryCounts): string => {
        const climbers = total === 1 ? 'climber' : 'climbers';
        const skippedCopy = skipped > 0
            ? ` ${skipped} ${skipped === 1 ? 'buddy was' : 'buddies were'} not added because custom favorites can hold up to ${F.LIMIT.toLocaleString('en-US')} climbers.`
            : '';
        return `${operation} complete: ${added} added, ${removed} removed. Custom list now has ${total} ${climbers}.${skippedCopy}`;
    };

    const setReplacementBusy = (busy: boolean): void => {
        replacementBusy = busy;
        for (const radio of sourceEls) radio.disabled = busy;
        mirrorCancelEl.disabled = busy;
        mirrorConfirmEl.disabled = busy;
        if (busy) {
            mirrorConfirmationEl.setAttribute('aria-busy', 'true');
            mirrorConfirmationEl.focus({ preventScroll: true });
        } else {
            mirrorConfirmationEl.removeAttribute('aria-busy');
        }
    };

    const dismissReplacementConfirmation = ({ restoreFocus = false }: { restoreFocus?: boolean } = {}): boolean => {
        if (replacementBusy) return false;
        pendingReplacement = null;
        mirrorConfirmationEl.hidden = true;
        if (restoreFocus && !mirrorEl.disabled) {
            const disclosure = mirrorEl.closest('details:not([open])');
            (disclosure?.querySelector<HTMLElement>('summary') || mirrorEl).focus();
        }
        return true;
    };

    // Restore lives on the Backup & sync surface now; this confirmation is only
    // the mirror action's, so it no longer branches on kind or reparents.
    const showReplacementConfirmation = (
        { replacement }: { kind?: string; replacement: FavoriteClimbersList },
        { focus = true }: { focus?: boolean } = {},
    ): void => {
        const { added, removed } = F.membershipChanges(favorites.entries, replacement.entries);
        const total = replacement.entries.length;
        const addedNoun = added === 1 ? 'buddy' : 'buddies';
        mirrorConfirmationTitleEl.textContent = 'Replace custom favorites?';
        mirrorConfirmationImpactEl.textContent = `${added} ${addedNoun} will be added. ${removed} custom ${removed === 1 ? 'favorite' : 'favorites'} will be removed.`;
        mirrorConfirmationSummaryEl.textContent = ` The custom list will then exactly match your ${total} current ${total === 1 ? 'buddy' : 'buddies'}. You can undo for 6 seconds after replacement.`;
        mirrorConfirmEl.textContent = 'Replace custom list';
        pendingReplacement = {
            replacement: F.cleanFavorites(replacement),
            favoritesSignature: favoritesSignature(),
            added,
            removed,
        };
        mirrorConfirmationEl.hidden = false;
        if (focus) mirrorCancelEl.focus();
    };

    const renderBuddyStatus = (): void => {
        buddyStatusEl.textContent = '';
        if (buddyState === 'loading') {
            buddyStatusEl.textContent = 'Refreshing…';
            return;
        }
        if (buddyCache) {
            const count = buddyCache.entries.length;
            buddyStatusEl.textContent = `${count} ${count === 1 ? 'buddy' : 'buddies'} · ${relativeAge(buddyCache.fetchedAt)}`;
            if (buddyError) {
                buddyStatusEl.append(` · ${PeakbaggerError.message(buddyError)}`);
                appendBuddyRecovery(buddyError);
            }
            return;
        }
        if (buddyError) {
            buddyStatusEl.textContent = PeakbaggerError.message(buddyError);
            appendBuddyRecovery(buddyError);
        } else {
            buddyStatusEl.textContent = 'Never loaded';
        }
    };

    const sourceLabel = (value: FavoriteSourceKind): string => value === 'buddy' ? 'Buddy' : 'Manual';
    const addedLabel = (addedAt: number): string => new Date(addedAt).toLocaleDateString([], {
        year: 'numeric', month: 'short', day: 'numeric',
    });

    const renderFavoriteRow = (entry: FavoriteClimberEntry): HTMLLIElement => {
        const item = document.createElement('li');
        item.className = 'favorite-item';
        item.dataset.cid = String(entry.cid);
        const body = document.createElement('div');
        body.className = 'favorite-body';
        const name = document.createElement('a');
        name.className = 'favorite-name';
        name.href = F.climberPageUrl(entry.cid) ?? '';
        name.target = '_blank';
        name.rel = 'noopener noreferrer';
        name.textContent = entry.name;
        const meta = document.createElement('p');
        meta.className = 'favorite-meta';
        const tag = document.createElement('span');
        tag.className = 'favorite-source-tag';
        tag.textContent = sourceLabel(entry.source);
        meta.append(`#${entry.cid}`, ' · ', `Added ${addedLabel(entry.addedAt)}`, tag);
        body.append(name, meta);
        const remove = OptionsUtils.actionButton(
            'quiet favorite-remove',
            'Remove',
            `Remove ${entry.name} from favorites`,
        );
        remove.dataset.action = 'delete';
        remove.addEventListener('click', () => { void beginDelete(entry); });
        item.append(body, remove);
        return item;
    };

    const renderDeletedRow = (entry: FavoriteClimberEntry): HTMLLIElement => {
        const item = document.createElement('li');
        item.className = 'favorite-item favorite-item-deleted';
        item.dataset.cid = String(entry.cid);
        const message = document.createElement('span');
        message.textContent = 'Favorite removed';
        const undo = OptionsUtils.actionButton(
            'link favorite-undo',
            'Undo',
            `Restore ${entry.name} to favorites`,
        );
        undo.dataset.action = 'undo';
        undo.addEventListener('click', () => { void undoDelete(entry.cid); });
        item.append(message, undo);
        return item;
    };

    const renderList = (): void => {
        const restoreFocus = OptionsUtils.listFocusRestorer(listEl, 'cid', () =>
            customPanelEl.hidden ? sourceEls.find(radio => radio.checked) : searchEl);
        const compare = sortEl.value === 'name' ? F.byName : F.byAddedAtDesc;
        const query = searchEl.value.trim();
        const matchesSource = (entry: FavoriteClimberEntry): boolean => sourceFilter === 'all' || entry.source === sourceFilter;
        const sourceCounts = favorites.entries.reduce<Record<FavoritesSourceFilter, number>>((counts, entry) => {
            counts[entry.source]++;
            return counts;
        }, { all: favorites.entries.length, buddy: 0, manual: 0 });
        for (const button of sourceFilterEls) {
            const value = button.dataset.favoritesSourceFilter as FavoritesSourceFilter;
            const count = sourceCounts[value];
            const countNode = button.querySelector('[data-favorites-source-count]');
            if (countNode) countNode.textContent = count.toLocaleString('en-US');
            button.setAttribute('aria-pressed', String(value === sourceFilter));
            const formattedCount = count.toLocaleString('en-US');
            const noun = count === 1 ? 'favorite' : 'favorites';
            const label = value === 'buddy'
                ? `Show ${formattedCount} ${noun} added from buddies`
                : value === 'manual'
                    ? `Show ${formattedCount} manually added ${noun}`
                    : `Show all ${formattedCount} ${noun}`;
            button.setAttribute('aria-label', label);
        }
        const activeRows = favorites.entries
            .filter(entry => !pendingDeletes.has(entry.cid))
            .filter(matchesSource)
            .map(entry => ({ entry, score: F.fuzzyScore(entry, query) }))
            .filter((row): row is { entry: FavoriteClimberEntry; score: number } => row.score != null);
        activeRows.sort((left, right) => query
            ? left.score - right.score || compare(left.entry, right.entry)
            : compare(left.entry, right.entry));
        const rows = activeRows.map(({ entry }) => ({ entry, item: renderFavoriteRow(entry) }));
        for (const pending of pendingDeletes.values()) {
            if (!matchesSource(pending.entry)) continue;
            if (F.fuzzyScore(pending.entry, query) == null) continue;
            rows.push({ entry: pending.entry, item: renderDeletedRow(pending.entry) });
        }
        if (!query) rows.sort((left, right) => compare(left.entry, right.entry));
        listEl.textContent = '';
        listEl.append(...rows.map(row => row.item));
        listEl.hidden = rows.length === 0;
        const total = favorites.entries.length;
        const noun = total === 1 ? 'favorite' : 'favorites';
        const formattedTotal = total.toLocaleString('en-US');
        const formattedMatches = activeRows.length.toLocaleString('en-US');
        countEl.textContent = query || sourceFilter !== 'all'
            ? `${formattedMatches} of ${formattedTotal} ${noun}`
            : `${formattedTotal} ${noun}`;
        const sourceDescription = sourceFilter === 'buddy' ? 'added from buddies'
            : sourceFilter === 'manual' ? 'manually added'
                : '';
        emptyEl.textContent = query
            ? sourceFilter === 'buddy'
                ? `No favorites added from buddies match “${query}”.`
                : `No ${sourceDescription ? `${sourceDescription} ` : ''}favorites match “${query}”.`
            : sourceDescription
                ? sourceFilter === 'buddy'
                    ? 'No favorites added from buddies yet.'
                    : `No ${sourceDescription} favorites yet.`
                : 'No favorite climbers yet.';
        emptyEl.hidden = rows.length > 0;
        undoAllEl.hidden = !pendingBulk;
        restoreFocus();
    };

    const renderPanels = (): void => {
        for (const radio of sourceEls) radio.checked = radio.value === source;
        buddyPanelEl.hidden = source !== 'buddies';
        customPanelEl.hidden = source !== 'custom';
        renderBuddyStatus();
        renderList();
    };

    const mutateFavorites = async (mutation: Record<string, unknown>): Promise<FavoritesMutateResponse> => {
        const response = await send<FavoritesMutateResponse>({ type: F.MUTATION_MESSAGE_TYPE, mutation });
        if (response?.favorites) {
            favorites = F.cleanFavorites(response.favorites);
            renderList();
        }
        if (!response?.ok) {
            throw Object.assign(
                new Error(response?.error?.message || 'Favorite climbers are unavailable. Try again.'),
                { code: response?.error?.code || 'unavailable' },
            );
        }
        return response;
    };

    const refresh = async (): Promise<void> => {
        const revision = ++refreshRevision;
        try {
            const values = await store.get([F.FAVORITES_KEY, F.BUDDY_CACHE_KEY]);
            if (revision !== refreshRevision) return;
            favorites = F.cleanFavorites(values[F.FAVORITES_KEY]);
            acceptBuddyCache(values[F.BUDDY_CACHE_KEY]);
            renderPanels();
            if (pendingReplacement && !replacementBusy) {
                showReplacementConfirmation(pendingReplacement, { focus: false });
            }
        } catch {
            if (revision !== refreshRevision) return;
            flash('Favorite climbers are unavailable', { error: true });
        }
    };

    const loadSignedInBuddies = async (): Promise<{ ownerCid: number; entries: BuddyEntry[]; fetchedAt?: number }> => {
        const url = F.signedInBuddyListUrl(PEAKBAGGER_ORIGIN) ?? '';
        const result = await fetchPeakbaggerDocument(url, { kind: 'buddies' });
        if (result.kind !== 'ok') {
            if (result.error?.code === 'signed-out' || result.error?.code === 'cloudflare') {
                const fallback = await loadBuddiesInSiteTab();
                if (fallback.cache) return fallback.cache;
                // Only an unavailable fallback leaves the original diagnosis
                // standing. One that ran and ran out of time must say so: the
                // signed-out error would tell a signed-in user to sign in,
                // which is both wrong and unactionable.
                // A challenged navigation still needs a user-completed check;
                // a timeout cannot establish that the challenge disappeared.
                if (fallback.timedOut && result.error.code !== 'cloudflare') {
                    throw PeakbaggerError.failure('timeout', { resource: 'buddies' });
                }
            }
            throw result.error;
        }
        const ownerCid = ownerClimberId(result.document);
        if (ownerCid == null) throw PeakbaggerError.failure('signed-out', { resource: 'buddies' });
        return { ownerCid, entries: F.parseBuddyDocument(result.document) };
    };

    // Resolves { cache, timedOut }. The two null cases are deliberately
    // distinct: an unavailable fallback never ran and says nothing about why
    // the direct read failed, while one that ran out of time is itself the
    // failure the user needs told about.
    const UNAVAILABLE = { cache: null, timedOut: false };

    const loadBuddiesInSiteTab = async (): Promise<{ cache: BuddyCache | null; timedOut: boolean }> => {
        const tabs = extensionApi.tabs;
        const changes = extensionApi.storage.onChanged;
        let helperUrl = extensionApi.runtime.getURL?.('options/buddy-refresh.html');
        if (!helperUrl || !tabs?.create || !tabs?.remove
            || !tabs?.sendMessage
            || !changes?.addListener || !changes?.removeListener) return UNAVAILABLE;

        const promiseTabs = typeof globalThis.browser !== 'undefined'
            && extensionApi === globalThis.browser;
        // Prefer an open Buddy List, then the most recently used site tab.
        // This keeps first-party cookies/clearance on the user's working host.
        if (tabs.query) {
            try {
                const siteQuery: chrome.tabs.QueryInfo = { url: [...PEAKBAGGER_HOSTS].map(host => `https://${host}/*`) };
                const siteTabs = await (promiseTabs
                    ? tabs.query(siteQuery)
                    : new Promise<chrome.tabs.Tab[]>((resolve, reject) => tabs.query(siteQuery, result => {
                        if (extensionApi.runtime.lastError) reject(new Error('Site tabs are unavailable.'));
                        else resolve(result);
                    })));
                const buddyTab = (candidate: chrome.tabs.Tab & { url: string }): boolean => {
                    const url = new URL(candidate.url);
                    return /^\/report\/report\.aspx$/i.test(url.pathname) && url.searchParams.get('r') === 'b';
                };
                const candidates = siteTabs.filter((candidate): candidate is chrome.tabs.Tab & { url: string } => {
                    if (!candidate.url) return false;
                    try { return isPeakbaggerPageOrigin(new URL(candidate.url).origin); }
                    catch { return false; }
                }).sort((a, b) => Number(buddyTab(b)) - Number(buddyTab(a))
                    || Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
                buddyOrigin = candidates.length ? new URL(candidates[0].url).origin : PEAKBAGGER_ORIGIN;
            } catch { buddyOrigin = PEAKBAGGER_ORIGIN; }
        }
        if (buddyOrigin !== PEAKBAGGER_ORIGIN) helperUrl += `#origin=${encodeURIComponent(buddyOrigin)}`;
        const buddyUrl = F.signedInBuddyListUrl(buddyOrigin);
        const createTab = (details: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab | undefined> => promiseTabs
            ? tabs.create(details)
            : new Promise((resolve, reject) => {
                tabs.create(details, created => {
                    const error = extensionApi.runtime.lastError;
                    if (error) reject(new Error(error.message || 'Could not open the Buddy List.'));
                    else resolve(created);
                });
            });
        const removeTab = (tabId: number): void => {
            if (promiseTabs) {
                void tabs.remove(tabId).catch(() => {});
                return;
            }
            tabs.remove(tabId, () => { void extensionApi.runtime.lastError; });
        };

        const startedAt = Date.now();
        let listener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | null = null;
        let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
        let tab: chrome.tabs.Tab | null = null;
        let updatedListener: ((tabId: number, change: chrome.tabs.OnUpdatedInfo) => void) | null = null;
        let finished = false;
        let reading = false;
        let readAgain = false;
        let resolveCache!: (value: BuddyCache | null) => void;
        const cachePromise = new Promise<BuddyCache | null>(resolve => {
            resolveCache = resolve;
        });
        const finish = (value: BuddyCache | null): void => {
            if (finished) return;
            finished = true;
            if (timer != null) globalThis.clearTimeout(timer);
            if (listener) changes.removeListener(listener);
            listener = null;
            timer = null;
            resolveCache(value);
        };
        const readHelper = async (): Promise<void> => {
            const tabId = tab?.id;
            if (finished || typeof tabId !== 'number' || !Number.isInteger(tabId)) return;
            if (reading) { readAgain = true; return; }
            reading = true;
            try {
                const message = { type: F.BUDDY_PAGE_READ_TYPE };
                const response = await (promiseTabs
                    ? tabs.sendMessage<typeof message, BuddyPageReadResponse | null | undefined>(tabId, message)
                    : new Promise<BuddyPageReadResponse | null | undefined>((resolveRead, rejectRead) =>
                        tabs.sendMessage<typeof message, BuddyPageReadResponse | null | undefined>(tabId, message, reply => {
                            if (extensionApi.runtime.lastError) rejectRead(new Error('Buddy List is not ready.'));
                            else resolveRead(reply);
                        })));
                const cache = F.cleanBuddyCache(response?.cache);
                if (response?.url === buddyUrl && cache && cache.fetchedAt >= startedAt
                    && Array.isArray(response?.cache?.entries)
                    && cache.entries.length === response.cache.entries.length) finish(cache);
            } catch { /* the helper can still be navigating or challenged */ }
            finally {
                reading = false;
                if (readAgain) { readAgain = false; void readHelper(); }
            }
        };
        listener = (updates, area) => {
            if (area !== 'local' || !updates[F.BUDDY_CACHE_KEY]) return;
            void readHelper();
        };
        changes.addListener(listener);
        if (tabs.onUpdated && typeof tabs.onUpdated.addListener === 'function'
            && typeof tabs.onUpdated.removeListener === 'function') {
            updatedListener = (tabId, change) => {
                if (tabId === tab?.id && change.status === 'complete') void readHelper();
            };
            tabs.onUpdated.addListener(updatedListener);
        }
        timer = globalThis.setTimeout(() => finish(null), SITE_TAB_REFRESH_MS);

        try {
            // Start at the packaged helper itself. A provisional about:blank
            // followed by an immediate update can strand Chrome 128 at loading.
            // The helper is local; its own redirect reaches the first-party site.
            tab = (await createTab({ url: helperUrl, active: false })) ?? null;
            if (typeof tab?.id !== 'number' || !Number.isInteger(tab.id)) return UNAVAILABLE;
            // Completion/cache events may precede create's callback. Reconcile
            // this exact helper immediately as well as on later notifications.
            void readHelper();
            const cache = await cachePromise;
            return { cache, timedOut: cache == null };
        } catch {
            return UNAVAILABLE;
        } finally {
            finished = true;
            if (timer != null) globalThis.clearTimeout(timer);
            if (listener) changes.removeListener(listener);
            if (updatedListener) tabs.onUpdated?.removeListener(updatedListener);
            const tabId = tab?.id;
            if (typeof tabId === 'number' && Number.isInteger(tabId)) {
                try { removeTab(tabId); }
                catch { /* the user or browser already closed it */ }
            }
        }
    };

    const refreshBuddies = (): Promise<BuddyCache | null> => {
        if (refreshPromise) return refreshPromise;
        buddyState = 'loading';
        buddyError = null;
        buddyFailure = null;
        setBusy(true);
        renderBuddyStatus();
        refreshPromise = (async (): Promise<BuddyCache | null> => {
            const snapshot = await beginBuddyCacheRead(extensionApi);
            const refreshed = await loadSignedInBuddies();
            const next: BuddyCache = { ownerCid: refreshed.ownerCid, entries: refreshed.entries, fetchedAt: refreshed.fetchedAt ?? Date.now() };
            try { await publishBuddyCache(extensionApi, snapshot, next); }
            catch (error) {
                const code = (error as { code?: unknown } | null | undefined)?.code;
                if (code !== 'storage') throw error;
                if (!buddyCache) buddyCache = next;
                buddyError = PeakbaggerError.failure('storage', { resource: 'buddies' });
                return next;
            }
            acceptBuddyCache((await store.get(F.BUDDY_CACHE_KEY))[F.BUDDY_CACHE_KEY]);
            return next;
        })().catch((error: unknown) => {
            const err = error as { code?: unknown } | null | undefined;
            buddyError = err && err.code
                ? error
                : PeakbaggerError.failure('network', { resource: 'buddies' });
            buddyFailure = {
                ownerCid: buddyCache?.ownerCid ?? null,
                fetchedAt: buddyCache?.fetchedAt ?? -1,
                failedAt: Date.now(),
            };
            return null;
        }).finally(() => {
            buddyState = 'idle';
            refreshPromise = null;
            setBusy(false);
            renderBuddyStatus();
        });
        return refreshPromise;
    };

    const beginDelete = async (entry: FavoriteClimberEntry): Promise<void> => {
        if (pendingDeletes.has(entry.cid)) return;
        const pending: PendingDelete = { entry, timer: undefined };
        pending.timer = globalThis.setTimeout(() => {
            pendingDeletes.delete(entry.cid);
            renderList();
        }, UNDO_MS);
        pendingDeletes.set(entry.cid, pending);
        try {
            await mutateFavorites({ kind: 'remove', cid: entry.cid });
        } catch {
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(entry.cid);
            renderList();
            flash("Couldn't remove the favorite", { error: true });
        }
    };

    const undoDelete = async (cid: number): Promise<void> => {
        const pending = pendingDeletes.get(cid);
        if (!pending) return;
        try {
            await mutateFavorites({ kind: 'add', entry: pending.entry });
            globalThis.clearTimeout(pending.timer);
            pendingDeletes.delete(cid);
            renderList();
            flash('Favorite restored');
        } catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            flash(err?.code === 'list-conflict' && typeof err.message === 'string' ? err.message : "Couldn't restore the favorite", { error: true });
        }
    };

    const beginReplacement = async (
        next: FavoriteClimbersList,
        message: string,
        expectedSignature = favoritesSignature(),
    ): Promise<boolean> => {
        const supersededPending = pendingBulk;
        const pending: PendingBulkReplacement = {
            snapshot: favorites,
            message,
            timer: undefined,
            appliedSignature: undefined,
        };
        try {
            const response = await mutateFavorites({
                kind: 'replace',
                favorites: next,
                expectedSignature,
            });
            pending.appliedSignature = response.signature;
        } catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            flash((err?.code === 'stale' || err?.code === 'list-conflict') && typeof err.message === 'string'
                ? err.message
                : "Couldn't update favorites", { error: true });
            return false;
        }
        if (supersededPending) globalThis.clearTimeout(supersededPending.timer);
        pending.timer = globalThis.setTimeout(() => {
            if (pendingBulk === pending) pendingBulk = null;
            renderList();
        }, UNDO_MS);
        pendingBulk = pending;
        undoMessageEl.textContent = message;
        renderList();
        return true;
    };

    const undoReplacement = async (): Promise<void> => {
        if (!pendingBulk) return;
        const pending = pendingBulk;
        try {
            await mutateFavorites({
                kind: 'replace',
                favorites: pending.snapshot,
                expectedSignature: pending.appliedSignature,
            });
            globalThis.clearTimeout(pending.timer);
            pendingBulk = null;
            renderList();
            flash('Custom favorites restored');
        } catch (error) {
            const err = error as { code?: unknown; message?: unknown } | null | undefined;
            flash((err?.code === 'stale' || err?.code === 'list-conflict') && typeof err.message === 'string'
                ? err.message
                : "Couldn't restore favorites", { error: true });
        }
    };

    const addClimber = async (): Promise<void> => {
        const cid = F.parseClimberInput(addInputEl.value);
        if (cid == null) {
            flash('Enter a climber id or Peakbagger climber-page link', { error: true });
            return;
        }
        addButtonEl.disabled = true;
        let name = '';
        try {
            const result = await fetchPeakbaggerDocument(F.climberPageUrl(cid) ?? '', { kind: 'climber' });
            if (result.kind !== 'ok') throw result.error;
            const doc = result.document;
            const identityLink = doc.querySelector<HTMLAnchorElement>('a[href*="ClimbListC.aspx?cid="], a[href*="climblistc.aspx?cid="]');
            const pageCid = identityLink ? numericParam(identityLink.href, 'cid', doc.baseURI) : null;
            name = F.climberNameFromDocument(doc);
            if (pageCid !== cid || !name) throw PeakbaggerError.failure('not-found', { resource: 'climber' });
        } catch (error) {
            flash(PeakbaggerError.message(error, { resource: `climber page for ID ${cid}` }), { error: true });
            addButtonEl.disabled = false;
            return;
        }
        try {
            const response = await mutateFavorites({
                kind: 'add',
                entry: { cid, name, addedAt: Date.now(), source: 'manual' },
            });
            addInputEl.value = '';
            flash(response.details?.added ? `${name} added to favorites` : `${name} is already in your favorites`);
        } catch (error) {
            const errMessage = error instanceof Error ? error.message : '';
            flash(errMessage || "The climber page loaded, but the favorite couldn't be saved on this device.", { error: true });
        } finally {
            addButtonEl.disabled = false;
        }
    };

    refreshBuddiesEl.addEventListener('click', () => {
        void refreshBuddies().then(cache => {
            if (cache && !buddyError) flash('Buddy List refreshed');
            else if (buddyError) flashBuddyError();
        });
    });
    addFormEl.addEventListener('submit', event => { event.preventDefault(); void addClimber(); });
    sortEl.addEventListener('change', renderList);
    searchEl.addEventListener('input', renderList);
    for (const button of sourceFilterEls) {
        button.addEventListener('click', () => {
            sourceFilter = button.dataset.favoritesSourceFilter as FavoritesSourceFilter;
            renderList();
        });
    }
    removeWithBuddyEl.addEventListener('change', () => {
        void save({ removeFavoriteWhenBuddyRemoved: removeWithBuddyEl.checked });
    });
    mergeEl.addEventListener('click', () => {
        dismissReplacementConfirmation();
        renderImportStatus('Loading your Buddy List…');
        void refreshBuddies().then(async cache => {
            if (!cache) {
                const message = PeakbaggerError.message(buddyError);
                renderImportStatus(message, buddyError);
                flashBuddyError();
                return;
            }
            try {
                const response = await mutateFavorites({
                    kind: 'merge-buddies',
                    entries: cache.entries,
                });
                const added = response.details?.added || 0;
                const skipped = response.details?.skipped || 0;
                const summary = completionCopy('Merge', {
                    added,
                    removed: 0,
                    total: response.favorites?.entries.length ?? favorites.entries.length,
                    skipped,
                });
                renderImportStatus(summary);
                flash(added
                    ? `Merge complete: ${added} added, 0 removed`
                    : skipped > 0 ? 'Custom favorites are full' : 'No changes to custom favorites');
            } catch {
                renderImportStatus("The Buddy List loaded, but the custom favorites couldn't be saved.");
                flash("Couldn't merge buddies", { error: true });
            }
        });
    });
    mirrorEl.addEventListener('click', () => {
        dismissReplacementConfirmation();
        renderImportStatus('Loading your Buddy List…');
        void refreshBuddies().then(cache => {
            if (!cache) {
                const message = PeakbaggerError.message(buddyError);
                renderImportStatus(message, buddyError);
                flashBuddyError();
                return;
            }
            renderImportStatus();
            showReplacementConfirmation({
                kind: 'mirror',
                replacement: F.mirrorBuddies(cache.entries),
            });
        });
    });
    mirrorCancelEl.addEventListener('click', () => {
        if (replacementBusy) return;
        dismissReplacementConfirmation({ restoreFocus: true });
    });
    mirrorConfirmEl.addEventListener('click', () => {
        if (!pendingReplacement || replacementBusy) return;
        if (pendingReplacement.favoritesSignature !== favoritesSignature()) {
            showReplacementConfirmation(pendingReplacement);
            return;
        }
        const pending = pendingReplacement;
        const { replacement, added, removed } = pending;
        setBusy(true);
        setReplacementBusy(true);
        renderImportStatus('Replacing custom favorites…');
        void beginReplacement(replacement, 'Custom list replaced with your Buddy List', pending.favoritesSignature)
            .then(changed => {
                setReplacementBusy(false);
                if (changed) {
                    dismissReplacementConfirmation();
                    renderImportStatus(completionCopy('Mirror', {
                        added, removed, total: replacement.entries.length,
                    }));
                    flash(`Mirror complete: ${added} added, ${removed} removed`);
                } else {
                    renderImportStatus("The Buddy List loaded, but the custom favorites couldn't be saved.");
                    mirrorConfirmEl.focus();
                }
            }).finally(() => {
                setReplacementBusy(false);
                setBusy(false);
            });
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || mirrorConfirmationEl.hidden || replacementBusy) return;
        event.preventDefault();
        dismissReplacementConfirmation({ restoreFocus: true });
    });
    undoAllButtonEl.addEventListener('click', () => { void undoReplacement(); });

    for (const radio of sourceEls) {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            source = radio.value === 'custom' ? 'custom' : 'buddies';
            if (source !== 'custom') dismissReplacementConfirmation();
            renderPanels();
            void save({ favoritesSource: source });
        });
    }

    if (extensionApi.storage.onChanged) {
        extensionApi.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && (changes[F.FAVORITES_KEY] || changes[F.BUDDY_CACHE_KEY])) {
                globalThis.clearTimeout(refreshTimer);
                refreshTimer = globalThis.setTimeout(() => { void refresh(); }, 20);
            }
        });
    }

    void refresh();

    return {
        populate(settings) {
            source = settings && settings.favoritesSource === 'custom' ? 'custom' : 'buddies';
            removeWithBuddyEl.checked = settings?.removeFavoriteWhenBuddyRemoved === true;
            if (source !== 'custom') dismissReplacementConfirmation();
            renderPanels();
        },
    };
};
