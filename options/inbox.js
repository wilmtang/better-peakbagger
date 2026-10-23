// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { matchLabel } from '../src/capture/match-confidence.js';
import { garminActivityLabel, positiveId } from '../src/garmin/garmin-api.js';
const ext = globalThis.browser || globalThis.chrome;
const $ = selector => document.querySelector(selector);
const send = async message => { const result = await ext.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || 'Your inbox could not be updated. Try again.'); return result; };
let current; let items = new Map(); let review = null; let busy = false; let accepted = new Set();
let statusError = false;
const rows = new Map();
const changedMatches = () => review && items.has(review.id)
    && JSON.stringify(review.analysis?.matches) !== JSON.stringify(items.get(review.id).analysis?.matches);
function updateReviewControls() {
    if (!review) return;
    const live = items.get(review.id), updated = changedMatches();
    const handoff = !!live?.handoff;
    $('#inbox-open').setAttribute('aria-disabled', String(!live || updated || !review.analysis));
    $('#inbox-refresh span').textContent = updated ? 'Review updated matches' : 'Refresh from Garmin';
    $('#inbox-refresh').setAttribute('aria-disabled', String(!live || handoff || (!updated && (!current.configured || ['key-rejected', 'permission'].includes(current.error?.code)))));
    $('#inbox-dismiss').setAttribute('aria-disabled', String(!live || handoff));
    $('#inbox-done').setAttribute('aria-disabled', String(!live));
    $('#inbox-saved').hidden = !handoff || !positiveId(current.cid);
    if (positiveId(current.cid)) $('#inbox-saved').href = `https://www.peakbagger.com/climber/ClimbListC.aspx?cid=${current.cid}`;
    for (const input of document.querySelectorAll('#inbox-matches input')) {
        input.disabled = !live || handoff || live.saved.includes(input.value);
    }
    if (!live) $('#inbox-review-status').textContent = 'This activity has left the inbox. Return to your activity list.';
    else if (updated) $('#inbox-review-status').textContent = 'Updated matches are ready. Review them before opening drafts.';
}
function showReview(id, focus = true) {
    review = items.get(id); if (!review) return;
    $('#inbox-list').hidden = true; $('#inbox-review').hidden = false;
    $('#inbox-review-title').textContent = `${garminActivityLabel(review.summary.type)} · ${review.summary.date}`;
    $('#inbox-matches').replaceChildren();
    for (const match of review.analysis?.matches || []) {
        const label = document.createElement('label'); label.className = 'garmin-match';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = match.id;
        checkbox.checked = match.classification === 'strong' && !review.saved.includes(String(match.id));
        checkbox.disabled = review.saved.includes(String(match.id)) || !!review.handoff;
        const text = document.createElement('div'); text.textContent = match.name;
        const detail = document.createElement('span'); detail.textContent = `${matchLabel(match.classification)}${Number.isFinite(match.confidence) ? ` · ${Math.round(match.confidence * (match.confidence <= 1 ? 100 : 1))}% confidence` : ''}${review.saved.includes(String(match.id)) ? ' · Saved and verified' : ''}`;
        text.append(detail); label.append(checkbox, text); $('#inbox-matches').append(label);
    }
    $('#inbox-review-status').textContent = review.handoff ? 'Draft forms were opened. Review their saved state before continuing.'
        : !review.analysis ? review.error || 'Waiting for peaks. Open Peakbagger, sign in, then Check now.' : 'Strong matches are selected. Review any Probable matches before opening drafts.';
    $('#inbox-timestamps').checked = false;
    updateReviewControls();
    if (focus) $('#inbox-back').focus();
    void Settings.get().then(prefs => { $('#inbox-timestamp-row').hidden = !prefs.removeGpxTimestamps || !review?.analysis?.hasTimestamps; });
}
const busyAction = async (button, status, operation) => {
    if (busy || button.getAttribute('aria-disabled') === 'true') return;
    if (status.id === 'inbox-status') statusError = false;
    busy = true; button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true'); status.textContent = 'Working…';
    try { await operation(); } catch (error) { status.textContent = error.message; if (status.id === 'inbox-status') statusError = true; }
    finally { busy = false;
        if (button.id === 'inbox-check') button.setAttribute('aria-disabled', String(current?.checking || !current?.enabled || ['key-rejected', 'permission'].includes(current?.error?.code)));
        else button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy'); updateReviewControls(); }
};
function paintList() {
    const pending = [...items.values()].filter(item => accepted.has(item.id));
    for (const [id, element] of rows) if (!items.has(id)) { element.remove(); rows.delete(id); }
    for (const item of pending) {
        let element = rows.get(item.id);
        if (!element) {
            element = document.createElement('article'); element.className = 'garmin-activity';
            const body = document.createElement('div'), date = document.createElement('p'), title = document.createElement('h2'), status = document.createElement('p');
            body.append(date, title, status); const button = document.createElement('button'); button.className = 'panel-button secondary'; button.textContent = 'Review activity';
            button.addEventListener('click', () => showReview(item.id)); element.append(body, button); rows.set(item.id, element); $('#inbox-list').append(element);
        }
        element.querySelector('p').textContent = item.summary.date;
        element.querySelector('h2').textContent = garminActivityLabel(item.summary.type);
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
    updateReviewControls();
    const history = current.history || [];
    for (const receipt of history) {
        let row = document.getElementById(`history-${receipt.id}`);
        if (!row) {
            row = document.createElement('div'); row.id = `history-${receipt.id}`; row.className = 'garmin-activity';
            const label = document.createElement('p'); row.append(label);
            const link = document.createElement('a'); link.textContent = 'View in Garmin'; link.target = '_blank'; link.rel = 'noopener noreferrer';
            if (positiveId(receipt.id)) link.href = `https://connect.garmin.com/app/activity/${receipt.id}`;
            row.append(link);
            if (receipt.dismissed) { const undo = document.createElement('button'); undo.className = 'panel-button secondary'; undo.textContent = 'Undo';
                undo.addEventListener('click', () => void busyAction(undo, $('#inbox-status'), async () => { await send({ type: 'GARMIN_UNDO', id: receipt.id }); accepted.add(receipt.id); await refresh(); })); row.append(undo); }
            $('#inbox-history-list').append(row);
        }
        row.querySelector('p').textContent = `${receipt.date ? `${receipt.date} · ` : ''}${receipt.dismissed ? 'Dismissed' : receipt.complete ? 'Completed' : 'Draft review in progress'}`;
        row.querySelector('button')?.setAttribute('aria-disabled', String(!receipt.undoAvailable));
    }
    for (const row of document.querySelectorAll('#inbox-history-list>div')) if (!history.some(receipt => row.id === `history-${receipt.id}`)) row.remove();
    if (initial) accepted = new Set(items.keys());
    const arrivals = [...items.keys()].filter(id => !accepted.has(id)); $('#inbox-new').hidden = !arrivals.length;
    $('#inbox-description').textContent = !current.configured ? 'Connect Garmin to import your activities.' : current.manual ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    if (!statusError) $('#inbox-status').textContent = current.error?.message || (current.checking ? 'Checking Garmin… Your drafts remain ready to review.'
        : current.lastCheck ? `Last checked ${new Date(current.lastCheck).toLocaleString()}${current.historyIncomplete ? ' · History check in progress' : ''}` : current.enabled ? 'Ready to check Garmin.' : 'Connect Garmin and enable drafts in Settings.');
    $('#inbox-update-key').hidden = !current.error || !['key-rejected', 'permission'].includes(current.error.code);
    $('#inbox-update-key').textContent = current.error?.code === 'permission' ? 'Allow Garmin access' : 'Update key';
    $('#inbox-check').setAttribute('aria-disabled', String(current.checking || !current.enabled || ['key-rejected', 'permission'].includes(current.error?.code)));
    paintList();
}
$('#inbox-check').addEventListener('click', () => void busyAction($('#inbox-check'), $('#inbox-status'), async () => { await send({ type: 'GARMIN_CHECK' }); await refresh(); }));
$('#inbox-new').addEventListener('click', () => { accepted = new Set(items.keys()); $('#inbox-new').hidden = true; paintList(); });
$('#inbox-back').addEventListener('click', () => { const id = review?.id; review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false;
    (rows.get(id)?.querySelector('button') || $('#inbox-check')).focus(); });
$('#inbox-open').addEventListener('click', () => void busyAction($('#inbox-open'), $('#inbox-review-status'), async () => {
    const selectedIds = [...document.querySelectorAll('#inbox-matches input:checked')].map(input => Number(input.value));
    if (!selectedIds.length && !items.get(review.id)?.handoff) throw new Error('Select at least one summit to review.');
    const tab = await ext.tabs.getCurrent();
    await send({ type: 'GARMIN_OPEN_DRAFTS', id: review.id, tabId: tab.id, selectedIds, includeTimestampsOnce: $('#inbox-timestamps').checked });
    $('#inbox-review-status').textContent = 'Drafts opened. Review each ascent and click Save in Peakbagger.';
    await refresh();
}));
$('#inbox-refresh').addEventListener('click', () => void busyAction($('#inbox-refresh'), $('#inbox-review-status'), async () => {
    if (changedMatches()) { showReview(review.id, false); return; }
    await send({ type: 'GARMIN_RETRY', id: review.id }); $('#inbox-review-status').textContent = 'Refreshing from Garmin. Your saved draft stays available.';
}));
for (const [selector, type] of [['#inbox-dismiss', 'GARMIN_DISMISS'], ['#inbox-done', 'GARMIN_DONE']]) $(selector).addEventListener('click', () => void busyAction($(selector), $('#inbox-review-status'), async () => {
    if (type === 'GARMIN_DONE' && !confirm('Mark this activity done? It will leave the inbox and will not be imported again.')) return;
    await send({ type, id: review.id }); review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false; await refresh();
}));
void refresh(true).catch(error => { $('#inbox-status').textContent = error.message; });
const timer = setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 2500);
addEventListener('pagehide', () => clearInterval(timer), { once: true });
