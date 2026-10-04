// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as I from './ignored-climbers.js';
import { observeIgnored } from './ignored-client.js';
import { createFavoriteSource } from './favorite-source.js';
import { selectedReportTable } from './report-adapters.js';
import { reportStyle, utilityButton, paintReveal } from './report-controls.js';
import { settings } from '../settings/settings.js';

let ignored = null, ignoredError = '', preference = null, preferenceError = '', sourceState = null;
let render = () => {}, preferenceGeneration = 0;
const ignoreObserver = observeIgnored(chrome, state => {
    ignored = state.list; ignoredError = state.error; render();
});
const source = createFavoriteSource({ api: chrome, settings, doc: document, onState: state => {
    sourceState = state; render();
} });
const preferenceChanged = (changes, area) => {
    if (area !== 'local' || !changes[I.PEAK_FILTER_KEY]) return;
    preferenceGeneration++; const valid = I.readPreference(changes[I.PEAK_FILTER_KEY].newValue);
    if (valid) preference = valid;
    preferenceError = valid ? '' : "Couldn't load the report preference."; render();
};
chrome.storage.onChanged.addListener(preferenceChanged);
const token = ++preferenceGeneration;
void chrome.storage.local.get(I.PEAK_FILTER_KEY).then(values => {
    if (token !== preferenceGeneration) return;
    preference = I.readPreference(values[I.PEAK_FILTER_KEY]);
    if (!preference) preferenceError = "Couldn't load the report preference.";
    render();
}).catch(() => { if (token === preferenceGeneration) { preferenceError = "Couldn't load the report preference."; render(); } });

// Conceal only a positively recognized table during the bounded local read.
let concealed = null, originalVisibility = '';
const restore = () => { if (concealed) concealed.style.visibility = originalVisibility; concealed = null; };
const scan = () => {
    if (concealed || (ignored && preference)) return;
    const target = selectedReportTable(document);
    if (target) { concealed = target.table; originalVisibility = concealed.style.visibility; concealed.style.visibility = 'hidden'; }
};
const startup = new MutationObserver(scan);
startup.observe(document, { childList: true, subtree: true }); scan();
const recovery = setTimeout(() => {
    if (!ignored && !ignoredError) ignoredError = "Couldn't load ignored climbers.";
    if (!preference && !preferenceError) preferenceError = "Couldn't load the report preference.";
    restore(); startup.disconnect(); render();
}, 3000);
const mount = () => {
    startup.disconnect();
    const target = selectedReportTable(document);
    if (!target || !target.records.length) { clearTimeout(recovery); restore(); return; }
    reportStyle(document);
    const { table, records } = target;
    if (!table.id) table.id = 'bpb-selected-reports';
    const displays = new Map(records.map(record => [record.row, record.row.style.display]));
    let reveal = false, full = false, busy = false;
    const tools = document.createElement('div'); tools.className = 'bpb-report-tools'; tools.id = 'bpb-peak-report-tools';
    const status = document.createElement('span'); status.className = 'bpb-report-status'; status.setAttribute('role', 'status');
    const revealStatus = document.createElement('span'); revealStatus.className = 'bpb-report-status';
    const error = document.createElement('span'); error.setAttribute('role', 'status');
    const savePreference = async value => {
        full = false; preference = { schemaVersion: 1, favoritesOnly: value }; busy = true; preferenceError = ''; render();
        try {
            const response = await chrome.runtime.sendMessage({ type: I.PREFERENCE_MESSAGE, favoritesOnly: value });
            if (!response?.ok) throw new Error();
            // The notification is authoritative; this response only confirms
            // success and must not replace a newer preference from another tab.
        } catch { preferenceError = "This view couldn't be remembered. Try again."; }
        finally { busy = false; render(); }
    };
    const favorites = utilityButton(document, '☆ Favorites', () => { void savePreference(!preference?.favoritesOnly); });
    favorites.className = 'bpb-report-favorites'; favorites.setAttribute('aria-controls', table.id);
    const revealButton = utilityButton(document, 'Show ignored', () => { full = false; reveal = !reveal; render(); });
    revealButton.setAttribute('aria-controls', table.id);
    const retry = utilityButton(document, 'Retry', () => {
        void ignoreObserver.refresh(); void source.retry();
        if (preferenceError) void savePreference(preference?.favoritesOnly || false);
    });
    const showAll = utilityButton(document, 'Show all reports', () => { void savePreference(false); });
    showAll.title = 'Turn off Favorites and remember this choice; ignored reports stay hidden.';
    const fullButton = utilityButton(document, 'View full list', () => { full = true; reveal = true; render(); });
    fullButton.title = 'Temporarily include ignored reports and bypass filters on this page.';
    const restoreFilters = utilityButton(document, 'Restore filters', () => { full = false; reveal = false; render(); });
    const manage = document.createElement('a'); manage.href = chrome.runtime.getURL('options/favorites.html');
    manage.textContent = 'Manage climber lists'; manage.target = '_blank'; manage.rel = 'noopener noreferrer';
    const utilities = document.createElement('span'); utilities.className = 'bpb-report-utilities';
    utilities.append(revealButton, revealStatus, status, error, retry, showAll, fullButton, restoreFilters, manage);
    tools.append(favorites, utilities);
    table.before(tools);
    const emptyRow = table.insertRow(); emptyRow.className = 'bpb-report-empty';
    const empty = emptyRow.insertCell(); empty.colSpan = 6;
    render = () => {
        const active = !full && preference?.favoritesOnly === true;
        const ids = new Set(ignored?.entries.map(entry => entry.cid) || []);
        const counts = I.visibility(records, ids, record => !active
            || (!!sourceState?.available && sourceState.ids.has(record.climberId)), reveal);
        const visible = new Set(counts.visible);
        for (const record of records) record.row.style.display = visible.has(record) ? displays.get(record.row) : 'none';
        const label = sourceState?.mode === 'custom' ? 'Favorites' : 'Climbing buddies';
        const favoriteCount = records.filter(r => sourceState?.ids.has(r.climberId) && (reveal || !ids.has(r.climberId))).length;
        favorites.textContent = `${preference?.favoritesOnly ? '★' : '☆'} ${label} · ${favoriteCount}`;
        favorites.setAttribute('aria-pressed', String(preference?.favoritesOnly === true));
        favorites.title = `Only show reports from your ${label.toLowerCase()}. Remembered on this device.`;
        favorites.disabled = busy; favorites.setAttribute('aria-busy', String(busy));
        paintReveal(revealButton, revealStatus, counts, reveal);
        status.textContent = `${counts.visible.length} of ${records.length} selected reports shown`;
        error.textContent = ignoredError || preferenceError || (active ? sourceState?.error || '' : '');
        if (active && sourceState?.loading) error.textContent = 'Loading climbing buddies…';
        emptyRow.hidden = counts.visible.length > 0;
        empty.textContent = active && !sourceState?.available ? sourceState?.loading ? 'Loading climbing buddies…'
            : "Couldn't load your climber list." : counts.ignoreHidden === records.length
            ? `All ${records.length} selected reports are from ignored climbers.`
            : active && counts.ignoredMatches > 0 ? "Your favorites' reports on this page are hidden."
                : `No selected reports from your ${label.toLowerCase()}.`;
        retry.hidden = !error.textContent || error.textContent === 'Loading climbing buddies…';
        showAll.hidden = !active || counts.visible.length > 0;
        fullButton.hidden = counts.visible.length > 0 || full;
        restoreFilters.hidden = !full;
        manage.hidden = counts.visible.length > 0 || !active;
        if ((ignored || ignoredError) && (preference || preferenceError)) { clearTimeout(recovery); restore(); }
        void source.refresh({ active });
    };
    window.addEventListener('pageshow', event => { if (event.persisted) {
        full = false; reveal = false; render(); void source.resume(); void ignoreObserver.refresh();
    } });
    window.addEventListener('pagehide', event => {
        restore(); source.pause(); if (!event.persisted) { source.stop(); ignoreObserver.stop(); }
    });
    source.reconcile(); render();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
