// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { matchLabel } from '../src/capture/match-confidence.js';
const ext = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
const send = async message => { const result = await ext.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || 'Your inbox could not be updated. Try again.'); return result; };
let current; let items = new Map(); let review = null; let busy = false; let accepted = new Set();
const rows = new Map();
function showReview(id) {
    review = items.get(id); if (!review) return;
    $('#inbox-list').hidden = true; $('#inbox-review').hidden = false;
    $('#inbox-review-title').textContent = `${review.summary.type.replace(/_/g, ' ')} · ${review.summary.date}`;
    $('#inbox-matches').replaceChildren();
    for (const match of review.analysis?.matches || []) {
        const label = document.createElement('label'); label.className = 'garmin-match';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = match.id;
        checkbox.checked = match.classification === 'strong' && !review.saved.includes(String(match.id));
        checkbox.disabled = review.saved.includes(String(match.id)) || !!review.handoff;
        const text = document.createElement('div'); text.textContent = match.name;
        const detail = document.createElement('span'); detail.textContent = `${matchLabel(match.classification)}${review.saved.includes(String(match.id)) ? ' · Saved and verified' : ''}`;
        text.append(detail); label.append(checkbox, text); $('#inbox-matches').append(label);
    }
    $('#inbox-open').hidden = !review.analysis;
    $('#inbox-review-status').textContent = review.handoff ? 'Draft forms were opened. Review their saved state before continuing.' : 'Strong matches are selected. Review any Probable matches before opening drafts.';
    void Settings.get().then(prefs => { $('#inbox-timestamp-row').hidden = !prefs.removeGpxTimestamps || !review?.analysis?.route.some(segment => segment.some(point => point.time !== null)); });
}
const busyAction = async (button, status, operation) => {
    if (busy || button.getAttribute('aria-disabled') === 'true') return;
    busy = true; button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true'); status.textContent = 'Working…';
    try { await operation(); } catch (error) { status.textContent = error.message; }
    finally { busy = false;
        if (button.id === 'inbox-check') button.setAttribute('aria-disabled', String(current?.checking || !current?.enabled || current?.error?.code === 'key-rejected'));
        else button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy'); }
};
function paintList() {
    const pending = [...items.values()].filter(item => accepted.has(item.id));
    for (const [id, element] of rows) if (!items.has(id)) { element.remove(); rows.delete(id); }
    for (const item of pending) {
        let element = rows.get(item.id);
        if (!element) {
            element = document.createElement('article'); element.className = 'garmin-activity';
            const body = document.createElement('div'), date = document.createElement('p'), title = document.createElement('h2'), status = document.createElement('p');
            body.append(date, title, status); const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Review activity';
            button.addEventListener('click', () => showReview(item.id)); element.append(body, button); rows.set(item.id, element); $('#inbox-list').append(element);
        }
        element.querySelector('p').textContent = item.summary.date;
        element.querySelector('h2').textContent = item.summary.type.replace(/_/g, ' ') || 'Activity';
        element.querySelectorAll('p')[1].textContent = item.analysis
            ? `${item.analysis.matches.filter(match => match.classification === 'strong').length} Strong · ${item.analysis.matches.filter(match => match.classification === 'probable').length} Probable`
            : item.phase === 'no-matches' ? 'No matching summits' : item.phase === 'no-gps' ? 'No usable GPS route' : item.error || 'Waiting for Peakbagger — open Peakbagger, sign in, then Check now.';
    }
    if (!pending.length && !$('#inbox-empty')) {
        const empty = document.createElement('p'); empty.id = 'inbox-empty'; empty.textContent = current?.configured ? 'No activities need review. Check now to look for activities.' : 'Connect Garmin in Settings to import your activities.'; $('#inbox-list').append(empty);
    } else if (pending.length) $('#inbox-empty')?.remove();
}
async function refresh(initial = false) {
    current = await send({ type: 'GARMIN_STATUS' }); items = new Map(current.items.map(item => [item.id, item]));
    if (review && items.has(review.id)) {
        review = items.get(review.id);
        if (review.handoff) for (const checkbox of document.querySelectorAll('#inbox-matches input')) checkbox.disabled = true;
    }
    if (initial) accepted = new Set(items.keys());
    const arrivals = [...items.keys()].filter(id => !accepted.has(id)); $('#inbox-new').hidden = !arrivals.length;
    $('#inbox-description').textContent = current.manual ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    $('#inbox-status').textContent = current.error?.message || (current.checking ? 'Checking Garmin… Your drafts remain ready to review.'
        : current.lastCheck ? `Last checked ${new Date(current.lastCheck).toLocaleString()}${current.historyIncomplete ? ' · History check in progress' : ''}` : current.enabled ? 'Ready to check Garmin.' : 'Connect Garmin and enable drafts in Settings.');
    $('#inbox-update-key').hidden = !current.error || !['key-rejected', 'permission'].includes(current.error.code);
    $('#inbox-check').setAttribute('aria-disabled', String(current.checking || !current.enabled || current.error?.code === 'key-rejected'));
    paintList();
}
$('#inbox-check').addEventListener('click', () => void busyAction($('#inbox-check'), $('#inbox-status'), async () => { await send({ type: 'GARMIN_CHECK' }); await refresh(); }));
$('#inbox-new').addEventListener('click', () => { accepted = new Set(items.keys()); $('#inbox-new').hidden = true; paintList(); });
$('#inbox-back').addEventListener('click', () => { review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false; });
$('#inbox-open').addEventListener('click', () => void busyAction($('#inbox-open'), $('#inbox-review-status'), async () => {
    const selectedIds = [...document.querySelectorAll('#inbox-matches input:checked')].map(input => Number(input.value));
    if (!selectedIds.length && !review?.handoff) throw new Error('Select at least one summit to review.');
    const tab = await ext.tabs.getCurrent();
    await send({ type: 'GARMIN_OPEN_DRAFTS', id: review.id, tabId: tab.id, selectedIds, includeTimestampsOnce: $('#inbox-timestamps').checked });
    $('#inbox-review-status').textContent = 'Drafts opened. Review each ascent and click Save in Peakbagger.';
    await refresh();
}));
for (const [selector, type] of [['#inbox-dismiss', 'GARMIN_DISMISS'], ['#inbox-done', 'GARMIN_DONE']]) $(selector).addEventListener('click', () => void busyAction($(selector), $('#inbox-review-status'), async () => {
    if (type === 'GARMIN_DONE' && !confirm('Mark this activity done? It will leave the inbox and will not be imported again.')) return;
    await send({ type, id: review.id }); review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false; await refresh();
}));
void refresh(true).catch(error => { $('#inbox-status').textContent = error.message; });
const timer = setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 2500);
addEventListener('pagehide', () => clearInterval(timer), { once: true });
