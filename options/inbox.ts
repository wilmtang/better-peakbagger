// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { matchReading } from '../src/capture/match-reading.ts';
import { CLASSIFICATIONS, matchLabel, matchTone } from '../src/capture/match-confidence.js';
import { garminActivityLabel, positiveId } from '../src/garmin/garmin-api.ts';

interface InboxMatch { id: number; name: string; classification: string; confidence?: number }
interface InboxItem {
    id: string; phase: string; saved: string[]; error?: string | null; handoff?: boolean;
    summary: { type: string; date: string; name?: string; localStart?: string };
    analysis: { matches: InboxMatch[]; hasTimestamps?: boolean } | null;
}
interface InboxReceipt { id: string; complete?: boolean; dismissed?: boolean; date?: string; undoAvailable?: boolean }
interface InboxStatus {
    ok: true; featureEnabled?: boolean; configured?: boolean; enabled?: boolean; manual?: boolean; checking?: boolean;
    cid?: string | null; queued?: number; lastCheck?: number; historyIncomplete?: boolean;
    error?: { code?: string; message?: string; storage?: boolean } | null; peakbaggerBlocked?: { code: string } | null;
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
let dismissal: { id: string; text: string; error: string } | null = null;
const errorSignature = () => JSON.stringify([current?.error?.code || null, current?.error?.message || null]);
// Garmin's own title names the activity; items without one fall back to its type.
const activityTitle = (item: InboxItem) => item.summary.name || garminActivityLabel(item.summary.type);
// Garmin dates are the activity's local wall clock, so format them as UTC to keep the day and time unchanged.
const formatWhen = (date: string, time = '') => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const moment = new Date(`${date}T${/^\d{2}:\d{2}$/.test(time) ? time : '00:00'}:00Z`);
    if (Number.isNaN(moment.getTime())) return date;
    const day = moment.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
        ...(moment.getUTCFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
    return /^\d{2}:\d{2}$/.test(time) ? `${day}, ${moment.toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })}` : day;
};
const activityWhen = (item: InboxItem) => formatWhen(item.summary.date, (item.summary.localStart || '').slice(11, 16));
// Garmin's default titles repeat (place + sport), so wherever the activity is
// named without its row — status line, accessible names — its time goes with it.
const activityName = (item: InboxItem) => [activityTitle(item), activityWhen(item)].filter(Boolean).join(', ');
// The detail line: the type (when a title stands in for it) and when.
const activityDetail = (item: InboxItem) => {
    const type = garminActivityLabel(item.summary.type);
    return [item.summary.name && type !== item.summary.name ? type : '', activityWhen(item)].filter(Boolean).join(' · ');
};
// The row's outcome as labelled parts; match counts carry their Strong/Probable tone.
// Names and tones come from match-confidence, so the row agrees with the review.
const activityStatus = (item: InboxItem): { text: string; tone?: string }[] => {
    if (item.handoff) return [{ text: 'Draft forms opened' }];
    const counts = new Map<string, { text: string; tone: string; count: number }>();
    for (const classification of CLASSIFICATIONS) for (const match of item.analysis?.matches || []) if (match.classification === classification) {
        const label = matchLabel(classification), part = counts.get(label) || { text: label, tone: matchTone(classification), count: 0 };
        part.count++; counts.set(label, part);
    }
    if (counts.size) return [...counts.values()].map(({ text, tone, count }) => ({ text: `${count} ${text}`, tone }));
    return [{ text: item.analysis || item.phase === 'no-matches' ? 'No matching summits' : item.phase === 'no-gps' ? 'No usable GPS route'
        : item.error || 'Waiting for peak check' }];
};
// Newest activity first: Garmin's local start, then its date, then the larger (later) activity ID.
const startKey = (item: InboxItem) => (item.summary.localStart || item.summary.date || '').replace('T', ' ');
// ISO keys and same-width IDs compare exactly as strings. Local start matches the
// times shown, even if activities were recorded in different time zones.
const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
const newestFirst = (a: InboxItem, b: InboxItem) => descending(startKey(a), startKey(b))
    || b.id.length - a.id.length || descending(a.id, b.id);
// Writes only changed text, so polling keeps a selection or screen-reader position.
const setText = (element: Element, text: string) => { if (element.textContent !== text) element.textContent = text; };
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
    // A full inbox cannot store a refreshed route; Refresh would do nothing.
    $('#inbox-refresh').setAttribute('aria-disabled', String(busy || !live || handoff || (!updated && (!current.configured || !!current.error?.storage || ['key-rejected', 'permission'].includes(current.error?.code as string)))));
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
    $('#inbox-review-title').textContent = activityTitle(review);
    $('#inbox-review-detail').textContent = activityDetail(review);
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
// Dismiss from the list: the dismissal is stated in the status line with its
// one-minute Undo, so it needs no confirmation and never opens the review.
const dismissFromList = (button: HTMLElement, item: InboxItem) => busyAction(button, $('#inbox-status'), async () => {
    // Focus follows the screen: the row below, else the row above.
    const row = rows.get(item.id), focused = document.activeElement === button;
    const sibling = (element: Element | null | undefined, step: 'nextElementSibling' | 'previousElementSibling') =>
        element?.[step]?.classList.contains('garmin-activity') ? element[step] : null;
    const next = sibling(row, 'nextElementSibling') || sibling(row, 'previousElementSibling');
    await send({ type: 'GARMIN_DISMISS', id: item.id });
    dismissal = { id: item.id, text: `${activityName(item)} dismissed.`, error: errorSignature() }; statusError = false;
    await refresh();
    if (focused && !button.isConnected) ((next?.isConnected && next.querySelector<HTMLElement>('.garmin-activity-review')) || $('#inbox-check')).focus();
});
function paintList() {
    const pending = [...items.values()].filter(item => accepted.has(item.id)).sort(newestFirst);
    for (const [id, element] of rows) if (!items.has(id)) { element.remove(); rows.delete(id); }
    const list = $('#inbox-list'), focused = document.activeElement as HTMLElement | null;
    pending.forEach((item, index) => {
        let element = rows.get(item.id);
        if (!element) {
            element = document.createElement('article'); element.className = 'garmin-activity';
            const body = document.createElement('div'); body.className = 'garmin-activity-body';
            const title = document.createElement('h2'), meta = document.createElement('p');
            const when = document.createElement('span'), status = document.createElement('span'); status.className = 'garmin-activity-status';
            meta.append(when, status); body.append(title, meta);
            const actions = document.createElement('div'); actions.className = 'garmin-activity-actions';
            const reviewButton = document.createElement('button'); reviewButton.type = 'button'; reviewButton.className = 'panel-button secondary garmin-activity-review'; reviewButton.textContent = 'Review';
            reviewButton.addEventListener('click', () => showReview(item.id));
            const dismissButton = document.createElement('button'); dismissButton.type = 'button'; dismissButton.className = 'panel-button quiet garmin-activity-dismiss'; dismissButton.textContent = 'Dismiss';
            dismissButton.addEventListener('click', () => { const live = items.get(item.id); if (live && !live.handoff) void dismissFromList(dismissButton, live); });
            actions.append(reviewButton, dismissButton); element.append(body, actions); rows.set(item.id, element);
        }
        const status = activityStatus(item), name = activityName(item);
        setText(element.querySelector('h2')!, activityTitle(item));
        setText(element.querySelector('p > span')!, activityDetail(item));
        const statusLine = element.querySelector<HTMLElement>('.garmin-activity-status')!, signature = JSON.stringify(status);
        if (statusLine.dataset.signature !== signature) {
            statusLine.dataset.signature = signature;
            statusLine.replaceChildren(...status.flatMap((part, position) => {
                const label = document.createElement('span'); label.textContent = part.text; if (part.tone) label.dataset.tone = part.tone;
                return position ? [' · ', label] : [label];
            }));
        }
        // Visible text first, then the time that tells repeated titles apart.
        element.querySelector('.garmin-activity-review')!.setAttribute('aria-label', `Review ${name}`);
        const dismissButton = element.querySelector<HTMLElement>('.garmin-activity-dismiss')!;
        dismissButton.setAttribute('aria-label', `Dismiss ${name}`);
        // Opened draft forms cannot be dismissed (Mark done in the review finishes
        // them). The slot stays reserved so every row's Review lines up.
        if (item.handoff && document.activeElement === dismissButton) element.querySelector<HTMLElement>('.garmin-activity-review')!.focus();
        dismissButton.toggleAttribute('data-unavailable', !!item.handoff);
        // Place each row in newest-first order, moving only rows that are out of place.
        if (list.children[index] !== element) list.insertBefore(element, list.children[index] || null);
    });
    if (focused && !list.contains(document.activeElement) && list.contains(focused)) focused.focus({ preventScroll: true });
    if (!pending.length && !document.querySelector('#inbox-empty')) {
        const empty = document.createElement('p'); empty.id = 'inbox-empty'; empty.textContent = current?.configured ? 'No activities need review. Check now to look for activities.' : 'Connect Garmin in Settings to import your activities.'; list.append(empty);
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
            $('#inbox-history-list').prepend(row);
        }
        // Undo exists only while the worker offers it; an expired one is removed,
        // not left behind as a dead control.
        const offered = !!receipt.dismissed && !!receipt.undoAvailable;
        const existing = row.querySelector('button');
        if (offered && !existing) { const undo = document.createElement('button'); undo.className = 'panel-button secondary'; undo.textContent = 'Undo';
            undo.addEventListener('click', () => void undoDismissal(undo, receipt.id)); row.append(undo); }
        if (!offered && existing && existing.getAttribute('aria-busy') !== 'true') removeControl(existing);
        setText(row.querySelector('p')!, `${receipt.date ? `${formatWhen(receipt.date) || receipt.date} · ` : ''}${receipt.dismissed ? 'Dismissed' : receipt.complete ? 'Completed' : 'Draft review in progress'}`);
    }
    // History arrives oldest first; show the most recent at the top, moving only rows out of place.
    const historyList = $('#inbox-history-list'), historyFocus = document.activeElement as HTMLElement | null;
    [...history].reverse().forEach((receipt, index) => {
        const row = document.getElementById(`history-${receipt.id}`)!;
        if (historyList.children[index] !== row) historyList.insertBefore(row, historyList.children[index] || null);
    });
    if (historyFocus && historyList.contains(historyFocus) && document.activeElement !== historyFocus) historyFocus.focus({ preventScroll: true });
    for (const row of document.querySelectorAll('#inbox-history-list>div')) if (!history.some(receipt => row.id === `history-${receipt.id}`)) row.remove();
    // A Garmin error that arrives after the dismissal outranks the notice; that
    // dismissal stays undoable from history. An error already showing (a full
    // inbox, say) must not hide the confirmation of the Dismiss that answers it.
    if (dismissal && ((current.error && errorSignature() !== dismissal.error) || !history.some(receipt => receipt.id === dismissal!.id && receipt.dismissed && receipt.undoAvailable))) dismissal = null;
    const statusUndo = $('#inbox-undo');
    if (!dismissal && !statusUndo.hidden && statusUndo.getAttribute('aria-busy') !== 'true') removeControl(statusUndo);
    if (dismissal) statusUndo.hidden = false;
    if (initial) accepted = new Set(items.keys());
    const arrivals = [...items.keys()].filter(id => !accepted.has(id)); $('#inbox-new').hidden = !arrivals.length;
    $('#inbox-description').textContent = !current.configured ? 'Connect Garmin to import your activities.' : current.manual ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    const queued = current.queued || 0;
    $('#inbox-queue').textContent = queued ? `${queued} ${queued === 1 ? 'activity' : 'activities'} waiting for peak checks. Visit Peakbagger to resume.` : 'No activities waiting for peak checks.';
    // With nothing waiting the explanation has no subject; close it, moving focus
    // off the info button before the button is hidden.
    if (!queued) { if (document.activeElement === $('#inbox-why-peakbagger')) $('#inbox-check').focus(); setWhyPeakbagger(false); }
    $('#inbox-resume-peaks').hidden = !queued; $('#inbox-resume').hidden = !queued;
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
// Why peak checks need an open Peakbagger tab: a toggletip the reader opens.
function setWhyPeakbagger(open: boolean) {
    $('#inbox-why-peakbagger-note').hidden = !open; $('#inbox-why-peakbagger').setAttribute('aria-expanded', String(open));
}
$('#inbox-why-peakbagger').addEventListener('click', () => setWhyPeakbagger($('#inbox-why-peakbagger').getAttribute('aria-expanded') !== 'true'));
$('#inbox-why-peakbagger').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || $('#inbox-why-peakbagger-note').hidden) return;
    event.preventDefault(); setWhyPeakbagger(false); $('#inbox-why-peakbagger').focus();
});
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
        if (type === 'GARMIN_DISMISS') { dismissal = { id: target.id, text: `${activityName(target)} dismissed.`, error: errorSignature() }; statusError = false; }
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
