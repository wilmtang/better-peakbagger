// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { matchReading } from '../src/capture/match-reading.ts';
import { garminActivityLabel, positiveId } from '../src/garmin/garmin-api.js';

interface InboxMatch { id: number; name: string; classification: string; confidence?: number }
interface InboxItem {
    id: string; phase: string; saved: string[]; error?: string | null; handoff?: boolean;
    summary: { type: string; date: string };
    analysis: { matches: InboxMatch[]; hasTimestamps?: boolean } | null;
}
interface InboxReceipt { id: string; complete?: boolean; dismissed?: boolean; date?: string; undoAvailable?: boolean }
interface InboxStatus {
    ok: true; featureEnabled?: boolean; configured?: boolean; enabled?: boolean; manual?: boolean; checking?: boolean;
    cid?: string | null; queued?: number; lastCheck?: number; historyIncomplete?: boolean;
    error?: { code?: string; message?: string } | null; peakbaggerBlocked?: { code: string } | null;
    items: InboxItem[]; history?: InboxReceipt[];
}
interface InboxPreferences { enableGarminInbox: boolean; removeGpxTimestamps?: boolean }
interface InboxReply { ok?: boolean; error?: { message?: string } }

const ext = ((globalThis as { browser?: typeof chrome }).browser || globalThis.chrome) as typeof chrome;
const $ = <Element extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<Element>(selector)!;
const send = async <Reply = InboxReply>(message: Record<string, unknown>): Promise<Reply> => {
    const result = await ext.runtime.sendMessage(message) as InboxReply | undefined;
    if (!result?.ok) throw new Error(result?.error?.message || 'Your inbox could not be updated. Try again.');
    return result as Reply;
};
let featureEnabled = false; let current: InboxStatus | undefined; let items = new Map<string, InboxItem>(); let review: InboxItem | null = null;
let busy = false; let accepted = new Set<string>();
let statusError = false, preferences: InboxPreferences | null = null, reviewStatusSignature = '';
// The latest dismissal, stated in the list's status row with its Undo while the
// worker still offers one. A newer dismissal replaces it; an earlier one stays
// undoable from history until it expires.
let dismissal: { id: string; text: string } | null = null;
const activityName = (item: InboxItem) => `${garminActivityLabel(item.summary.type)} · ${item.summary.date}`;
const reviewMessage = (item: InboxItem) => item.handoff ? 'Draft forms were opened. Review their saved state before continuing.'
    : item.analysis ? 'Strong matches are selected. Review any Probable matches before opening drafts.'
        : item.error || (item.phase === 'no-gps' ? 'No usable GPS route.' : item.phase === 'no-matches' ? 'No matching summits.'
            : 'Waiting for peak checks. Visit Peakbagger to resume.');
const rows = new Map<string, HTMLElement>();
const changedMatches = () => !!review && items.has(review.id)
    && JSON.stringify(review.analysis?.matches) !== JSON.stringify(items.get(review.id)!.analysis?.matches);
function updateReviewControls() {
    if (!review || !current) return;
    const live = items.get(review.id), updated = changedMatches();
    const handoff = !!live?.handoff;
    $('#inbox-open').setAttribute('aria-disabled', String(busy || !live || updated || !review.analysis));
    $('#inbox-refresh span').textContent = updated ? 'Review updated matches' : 'Refresh from Garmin';
    $('#inbox-refresh').setAttribute('aria-disabled', String(busy || !live || handoff || (!updated && (!current.configured || ['key-rejected', 'permission'].includes(current.error?.code as string)))));
    $('#inbox-dismiss').setAttribute('aria-disabled', String(busy || !live || handoff));
    $('#inbox-done').setAttribute('aria-disabled', String(busy || !live));
    $('#inbox-saved').hidden = !handoff || !positiveId(current.cid);
    if (positiveId(current.cid)) $<HTMLAnchorElement>('#inbox-saved').href = `https://www.peakbagger.com/climber/ClimbListC.aspx?cid=${current.cid}`;
    for (const input of document.querySelectorAll<HTMLInputElement>('#inbox-matches input')) {
        input.disabled = !live || handoff || live.saved.includes(input.value);
    }
    if (!live) hideDoneConfirmation();
    if (!live) $('#inbox-review-status').textContent = 'This activity has left the inbox. Return to your activity list.';
    else if (updated) $('#inbox-review-status').textContent = 'Updated matches are ready. Review them before opening drafts.';
    else {
        const signature = JSON.stringify([live.phase, live.error, handoff]);
        if (signature !== reviewStatusSignature) $('#inbox-review-status').textContent = reviewMessage(live);
        reviewStatusSignature = signature;
    }
}
function showReview(id: string, focus = true) {
    review = items.get(id) || null; if (!review) return;
    hideDoneConfirmation(false);
    $('#inbox-timestamp-row').hidden = !preferences?.removeGpxTimestamps || !review.analysis?.hasTimestamps;
    $('#inbox-list').hidden = true; $('#inbox-review').hidden = false;
    $('#inbox-review-title').textContent = activityName(review);
    $('#inbox-matches').replaceChildren();
    for (const match of review.analysis?.matches || []) {
        const label = document.createElement('label'); label.className = 'garmin-match';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(match.id);
        checkbox.checked = match.classification === 'strong' && !review.saved.includes(String(match.id));
        checkbox.disabled = review.saved.includes(String(match.id)) || !!review.handoff;
        const text = document.createElement('div'); text.textContent = match.name;
        const reading = matchReading(match.classification, match.confidence);
        const saved = review.saved.includes(String(match.id)) ? ' · Saved and verified' : '';
        const detail = document.createElement('span'); detail.textContent = `${reading.text}${saved}`; detail.setAttribute('aria-label', `${reading.spoken}${saved}`);
        text.append(detail); label.append(checkbox, text); $('#inbox-matches').append(label);
    }
    $('#inbox-review-status').textContent = reviewMessage(review);
    reviewStatusSignature = JSON.stringify([review.phase, review.error, !!review.handoff]);
    $<HTMLInputElement>('#inbox-timestamps').checked = false;
    updateReviewControls();
    if (focus) $('#inbox-back').focus();
}
const busyAction = async (button: HTMLElement, status: HTMLElement, operation: () => Promise<void>) => {
    if (!featureEnabled || busy || button.getAttribute('aria-disabled') === 'true') return;
    if (status.id === 'inbox-status') statusError = false;
    busy = true; button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true'); status.textContent = 'Working…';
    updateReviewControls();
    try { await operation(); } catch (error) { status.textContent = (error as Error).message; if (status.id === 'inbox-status') statusError = true; }
    finally { busy = false;
        if (button.id === 'inbox-check') button.setAttribute('aria-disabled', String(current?.checking || !current?.enabled || ['key-rejected', 'permission'].includes(current?.error?.code as string)));
        else if (button.closest('#inbox-history-list')) {
            const receipt = current?.history?.find(item => `history-${item.id}` === button.parentElement!.id);
            button.setAttribute('aria-disabled', String(!receipt?.undoAvailable));
        } else button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy'); updateReviewControls(); }
};
// Undo the dismissal of `id` from either the status row or its history row.
const undoDismissal = (button: HTMLElement, id: string) => busyAction(button, $('#inbox-status'), async () => {
    const focused = document.activeElement === button;
    await send({ type: 'GARMIN_UNDO', id });
    if (dismissal?.id === id) dismissal = null;
    // The control has done its job; it must not stay behind as a dead button.
    if (button.id === 'inbox-undo') button.hidden = true; else button.remove();
    accepted.add(id); await refresh();
    // From the status line, stay beside it: focusing the restored row could
    // scroll the page. From history, the restored row is the natural next stop.
    if (focused && (document.activeElement === button || document.activeElement === document.body)) {
        ((button.id !== 'inbox-undo' && rows.get(id)?.querySelector('button')) || $('#inbox-check')).focus();
    }
});
// Removing a focused control would drop focus to the page; move it to Check now.
const removeControl = (control: HTMLElement) => {
    const focused = document.activeElement === control;
    if (control.id === 'inbox-undo') control.hidden = true; else control.remove();
    if (focused) $('#inbox-check').focus();
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
        element.querySelector('p')!.textContent = item.summary.date;
        element.querySelector('h2')!.textContent = garminActivityLabel(item.summary.type);
        element.querySelectorAll('p')[1].textContent = item.analysis
            ? `${item.analysis.matches.filter(match => match.classification === 'strong').length} Strong · ${item.analysis.matches.filter(match => match.classification === 'probable').length} Probable`
            : item.phase === 'no-matches' ? 'No matching summits' : item.phase === 'no-gps' ? 'No usable GPS route' : item.error || 'Queued for peak checks — visit Peakbagger to resume.';
    }
    if (!pending.length && !document.querySelector('#inbox-empty')) {
        const empty = document.createElement('p'); empty.id = 'inbox-empty'; empty.textContent = current?.configured ? 'No activities need review. Check now to look for activities.' : 'Connect Garmin in Settings to import your activities.'; $('#inbox-list').append(empty);
    } else if (pending.length) document.querySelector('#inbox-empty')?.remove();
}
async function refresh(initial = false) {
    if (!featureEnabled) return;
    const next = await send<InboxStatus>({ type: 'GARMIN_STATUS' });
    if (!featureEnabled) return;
    if (next.featureEnabled === false) { applyFeature({ enableGarminInbox: false }); return; }
    current = next; items = new Map(current.items.map(item => [item.id, item]));
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
            $('#inbox-history-list').append(row);
        }
        // Undo exists only while the worker offers it; an expired one is removed,
        // not left behind as a dead control.
        const offered = !!receipt.dismissed && !!receipt.undoAvailable;
        const existing = row.querySelector('button');
        if (offered && !existing) { const undo = document.createElement('button'); undo.className = 'panel-button secondary'; undo.textContent = 'Undo';
            undo.addEventListener('click', () => void undoDismissal(undo, receipt.id)); row.append(undo); }
        if (!offered && existing && existing.getAttribute('aria-busy') !== 'true') removeControl(existing);
        row.querySelector('p')!.textContent = `${receipt.date ? `${receipt.date} · ` : ''}${receipt.dismissed ? 'Dismissed' : receipt.complete ? 'Completed' : 'Draft review in progress'}`;
    }
    for (const row of document.querySelectorAll('#inbox-history-list>div')) if (!history.some(receipt => row.id === `history-${receipt.id}`)) row.remove();
    // A Garmin error outranks the notice; that dismissal stays undoable from history.
    if (dismissal && (current.error || !history.some(receipt => receipt.id === dismissal!.id && receipt.dismissed && receipt.undoAvailable))) dismissal = null;
    const statusUndo = $('#inbox-undo');
    if (!dismissal && !statusUndo.hidden && statusUndo.getAttribute('aria-busy') !== 'true') removeControl(statusUndo);
    if (dismissal) statusUndo.hidden = false;
    if (initial) accepted = new Set(items.keys());
    const arrivals = [...items.keys()].filter(id => !accepted.has(id)); $('#inbox-new').hidden = !arrivals.length;
    $('#inbox-description').textContent = !current.configured ? 'Connect Garmin to import your activities.' : current.manual ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    const queued = current.queued || 0;
    $('#inbox-queue').textContent = queued ? `${queued} ${queued === 1 ? 'activity' : 'activities'} waiting for peak checks. Visit Peakbagger to resume.` : 'No activities waiting for peak checks.';
    $('#inbox-resume-peaks').hidden = !queued;
    const peakbaggerMessage = current.peakbaggerBlocked?.code === 'cloudflare'
        ? 'Peakbagger needs a human check. Your activities are queued safely.'
        : current.peakbaggerBlocked?.code === 'rate-limit' ? 'Peakbagger asked us to wait. Your activities are queued safely.' : null;
    if (!statusError) $('#inbox-status').textContent = dismissal?.text || current.error?.message || peakbaggerMessage || (current.checking ? 'Checking Garmin… Your drafts remain ready to review.'
        : current.lastCheck ? `Last checked ${new Date(current.lastCheck).toLocaleString()}${current.historyIncomplete ? ' · History check in progress' : ''}` : current.enabled ? 'Ready to check Garmin.' : 'Connect Garmin in Settings.');
    $('#inbox-update-key').hidden = !current.error || !['key-rejected', 'permission'].includes(current.error.code as string);
    $('#inbox-update-key').textContent = current.error?.code === 'permission' ? 'Allow Garmin access' : 'Update key';
    $('#inbox-check').setAttribute('aria-disabled', String(current.checking || !current.enabled || ['key-rejected', 'permission'].includes(current.error?.code as string)));
    paintList();
}
// Check now takes over the status line, so it retires the dismissal notice.
$('#inbox-check').addEventListener('click', () => void busyAction($('#inbox-check'), $('#inbox-status'), async () => {
    dismissal = null; await send({ type: 'GARMIN_CHECK' }); await refresh();
}));
$('#inbox-undo').addEventListener('click', () => { if (dismissal) void undoDismissal($('#inbox-undo'), dismissal.id); });
$('#inbox-new').addEventListener('click', () => { accepted = new Set(items.keys()); $('#inbox-new').hidden = true; paintList(); });
$('#inbox-back').addEventListener('click', () => { hideDoneConfirmation(false); const id = review?.id; review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false;
    ((id && rows.get(id)?.querySelector('button')) || $('#inbox-check')).focus(); });
$('#inbox-open').addEventListener('click', () => void busyAction($('#inbox-open'), $('#inbox-review-status'), async () => {
    const selectedIds = [...document.querySelectorAll<HTMLInputElement>('#inbox-matches input:checked')].map(input => Number(input.value));
    if (!selectedIds.length && !items.get(review!.id)?.handoff) throw new Error('Select at least one summit to review.');
    const tab = await ext.tabs.getCurrent();
    await send({ type: 'GARMIN_OPEN_DRAFTS', id: review!.id, tabId: tab!.id, selectedIds, includeTimestampsOnce: $<HTMLInputElement>('#inbox-timestamps').checked });
    $('#inbox-review-status').textContent = 'Drafts opened. Review each ascent and click Save in Peakbagger.';
    await refresh();
}));
$('#inbox-refresh').addEventListener('click', () => void busyAction($('#inbox-refresh'), $('#inbox-review-status'), async () => {
    if (changedMatches()) { showReview(review!.id, false); return; }
    await send({ type: 'GARMIN_RETRY', id: review!.id }); $('#inbox-review-status').textContent = 'Refreshing from Garmin. Your saved draft stays available.';
}));
// Done cannot be undone, so it asks in the page rather than with a native
// dialog, which cannot follow the theme and which the browser may suppress.
const hideDoneConfirmation = (restoreFocus = true) => {
    if ($('#inbox-done-confirmation').hidden) return;
    const focused = $('#inbox-done-confirmation').contains(document.activeElement);
    $('#inbox-done-confirmation').hidden = true; $('#inbox-done').setAttribute('aria-expanded', 'false');
    if (restoreFocus && focused) $('#inbox-done').focus();
};
$('#inbox-done').addEventListener('click', () => {
    if (!featureEnabled || busy || $('#inbox-done').getAttribute('aria-disabled') === 'true') return;
    $('#inbox-done-confirmation').hidden = false; $('#inbox-done').setAttribute('aria-expanded', 'true');
    $('#inbox-done-confirm').focus();
});
$('#inbox-done-cancel').addEventListener('click', () => hideDoneConfirmation());
$('#inbox-done-confirmation').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return; event.preventDefault(); hideDoneConfirmation();
});
for (const [selector, type] of [['#inbox-dismiss', 'GARMIN_DISMISS'], ['#inbox-done-confirm', 'GARMIN_DONE']] as const) $(selector).addEventListener('click', () => {
    if (!featureEnabled || busy || $(selector).getAttribute('aria-disabled') === 'true') return;
    void busyAction($(selector), $('#inbox-review-status'), async () => {
        const target = review!;
        await send({ type, id: target.id });
        if (type === 'GARMIN_DISMISS') { dismissal = { id: target.id, text: `${activityName(target)} dismissed.` }; statusError = false; }
        const focused = document.activeElement, restoreFocus = $('#inbox-review').contains(focused);
        hideDoneConfirmation(false);
        review = null; $('#inbox-review').hidden = true; $('#inbox-list').hidden = false; await refresh();
        if (restoreFocus && (document.activeElement === focused || document.activeElement === document.body)) $('#inbox-check').focus();
    });
});
const applyFeature = (settings: InboxPreferences) => {
    preferences = settings;
    const changed = featureEnabled !== settings.enableGarminInbox;
    featureEnabled = settings.enableGarminInbox;
    $('#inbox-content').hidden = !featureEnabled;
    $('#inbox-disabled').hidden = featureEnabled;
    if (changed && featureEnabled) void refresh(true).catch(error => { $('#inbox-status').textContent = (error as Error).message; });
};
void Settings.requireCurrent().then(applyFeature).catch(() => {
    $('#inbox-disabled').hidden = false;
    $('#inbox-disabled h1').textContent = 'Settings could not be read';
    $('#inbox-disabled p').textContent = 'Reload this page to try again.';
});
const unsubscribe = Settings.subscribe(applyFeature);
const timer = setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 2500);
addEventListener('pagehide', () => { clearInterval(timer); unsubscribe(); }, { once: true });
