// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { settings as Settings } from '../src/settings/settings.js';
import { GARMIN_PERMISSION } from '../src/garmin/garmin-api.js';
import { settingsSchema as Schema } from '../src/settings/settings-schema.js';
const ext = globalThis.browser || globalThis.chrome;
export async function initGarminSettings(root) {
    if (!root) return;
    root.classList.add('garmin-settings');
    root.innerHTML = `<h3 class="subsection-title" id="capture-garmin-heading">Garmin connection</h3>
      <p>Connect Garmin to import activities and prepare ascent drafts automatically.</p>
      <form class="garmin-key-form">
        <div class="garmin-key-label"><label for="garmin-key">Personal API key</label><a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer" aria-label="Get a Garmin API key (opens in a new tab)">Get a Garmin API key ↗</a></div>
        <p class="garmin-helper" id="garmin-key-help">Create a key in Garmin, then paste it below. Stored only on this device. Keys last up to one year.</p>
        <div class="garmin-key-entry"><input id="garmin-key" type="password" autocomplete="off" spellcheck="false" aria-describedby="garmin-key-help garmin-key-status"><button id="garmin-show-key" type="button" class="panel-button secondary" aria-pressed="false" data-sizing-label="Show"><span>Show</span></button></div>
        <p class="garmin-helper" id="garmin-connection-help">Disconnect removes the saved key and stops imports. Your drafts stay on this device.</p>
        <div class="garmin-actions"><button id="garmin-connect" type="submit" class="panel-button primary" data-sizing-label="Reconnect Garmin"><span>Connect Garmin</span></button><span class="connection-disconnect-slot"><button id="garmin-disconnect" type="button" class="panel-button secondary" aria-describedby="garmin-connection-help" hidden>Disconnect</button></span></div>
        <div class="garmin-feedback"><span aria-hidden="true">Garmin didn’t accept this key. Copy the full key or get a new one.</span><span id="garmin-key-status" role="status" aria-atomic="true">Not connected</span></div>
      </form>
      <div id="garmin-preferences" hidden>
        <div class="garmin-pref"><label for="garmin-frequency">Check every<small>How often to check while your browser is running.</small></label><select id="garmin-frequency"><option value="0">Manual only</option><option value="1">Every hour</option><option value="4">Every 4 hours</option><option value="12">Every 12 hours</option><option value="24">Every day</option><option value="custom">Custom…</option></select><label id="garmin-custom-hours-row" hidden>Hours <input id="garmin-custom-hours" type="number" min="1" max="168" value="6"></label></div>
        <div class="garmin-pref"><label for="garmin-recent">Recent check range<small id="garmin-recent-help">How far back each regular check looks.</small></label><select id="garmin-recent"><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="custom">Custom days…</option></select><label id="garmin-custom-days-row" hidden>Days <input id="garmin-custom-days" type="number" min="1" max="365" value="30"></label></div>
        <div class="garmin-pref"><label for="garmin-history">Full history range<small id="garmin-history-help">Checked weekly to find older activities uploaded late.</small></label><select id="garmin-history"><option value="connection">From connection date</option><option value="date">Choose start date…</option><option value="all">All available history</option></select><label id="garmin-date-row" hidden>From <input id="garmin-date" type="date"></label></div>
        <div class="garmin-pref"><label for="garmin-types">Activities<small>Mountain activities include hikes, walks, trail runs, rock climbing, mountaineering and backcountry skiing.</small></label><select id="garmin-types"><option value="walking">Mountain activities</option><option value="all">All activities</option></select></div>
        <p class="garmin-helper" id="garmin-scope-note">Ranges use activity dates. Recent checks stay within your full history range. Changing ranges keeps your existing drafts.</p>
        <div class="garmin-actions"><button id="garmin-save" class="panel-button secondary">Save preferences</button><a href="inbox.html" class="garmin-inbox-link">Open activity inbox</a></div>
        <p class="garmin-helper">While your browser runs, imports use routes to find peaks on Peakbagger. Drafts and reduced routes stay on this device until completed or removed. You review every ascent before Save.</p>
        <div class="garmin-feedback"><span aria-hidden="true">Open Peakbagger and sign in to prepare your drafts. Your activities stay in the inbox.</span><span id="garmin-settings-status" role="status" aria-atomic="true"></span></div>
        <button id="garmin-access" class="panel-button primary" hidden>Allow Garmin access</button>
        <details><summary>Connection details</summary><p>Full history checks find older uploads within your chosen range. Keys and drafts stay on this device.</p><div class="garmin-actions"><button id="garmin-full" class="panel-button secondary">Check full history</button><button id="garmin-delete" class="panel-button secondary" aria-disabled="true" aria-describedby="garmin-settings-status">Delete local Garmin data</button></div><p class="garmin-helper">Deleting local data removes drafts and import history. Garmin activities and Peakbagger ascents stay in place.</p></details>
      </div>`;
    const $ = selector => root.querySelector(selector);
    root.addEventListener('submit', event => event.preventDefault());
    const send = async message => { const result = await ext.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || 'Garmin could not finish this action. Try again.'); return result; };
    let featureEnabled = false; let state; let busy = false; let keyError = false; let settingsError = false;
    let revision = 0; let preferencesRevealed = false; let settingsUnavailable = false;
    let disconnectConfirmed = false;
    let pendingDrafts = null;
    const setDraftCount = count => {
        pendingDrafts = Number.isSafeInteger(count) && count >= 0 ? count : null;
        $('#garmin-delete').setAttribute('aria-disabled', String(pendingDrafts === null));
    };
    const perform = async (button, status, operation, { cleanup = false } = {}) => {
        if (busy || (!featureEnabled && !cleanup)) return; busy = true; revision++;
        if (status.id === 'garmin-key-status') { keyError = false; disconnectConfirmed = false; } else settingsError = false;
        button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true'); status.classList.remove('is-error'); status.textContent = 'Working…';
        try { await operation(); } catch (error) { status.textContent = error.message;
            status.classList.add('is-error');
            if (status.id === 'garmin-key-status') keyError = true; else settingsError = true; }
        finally { busy = false; button.removeAttribute('aria-disabled'); button.removeAttribute('aria-busy');
            $('#garmin-connect').setAttribute('aria-disabled', String(!featureEnabled)); }
    };
    const updateChoices = () => {
        $('#garmin-custom-hours-row').hidden = $('#garmin-frequency').value !== 'custom';
        $('#garmin-custom-days-row').hidden = $('#garmin-recent').value !== 'custom';
        $('#garmin-date-row').hidden = $('#garmin-history').value !== 'date';
        const manual = $('#garmin-frequency').value === '0';
        $('#garmin-recent-help').textContent = manual ? 'How far back Check now looks.' : 'How far back each regular check looks.';
        $('#garmin-history-help').textContent = manual ? 'Used when you choose Check full history.' : 'Checked weekly to find older activities uploaded late.';
    };
    const refresh = async ({ duringOperation = false } = {}) => {
        if (busy && !duringOperation) return;
        const expected = ++revision;
        const fullStatus = featureEnabled;
        let next;
        try { next = await send({ type: fullStatus ? 'GARMIN_STATUS' : 'GARMIN_CONNECTION_STATUS' }); }
        catch (error) {
            if (expected !== revision) return;
            setDraftCount(null);
            if (!settingsError) {
                $('#garmin-settings-status').textContent = 'Local drafts could not be checked. Deleting local data is unavailable.';
                $('#garmin-settings-status').classList.add('is-error');
            }
            throw error;
        }
        if (expected !== revision || (busy && !duringOperation)) return;
        if (state && !!state.configured !== !!next.configured) keyError = false;
        if (next.configured) disconnectConfirmed = false;
        state = next;
        setDraftCount(fullStatus ? state.pending : null);
        preferencesRevealed ||= !!(state.configured || state.pending);
        $('#garmin-preferences').hidden = !featureEnabled || !preferencesRevealed;
        $('#garmin-disconnect').hidden = !state.configured;
        $('#garmin-full').disabled = !state.configured;
        $('#garmin-connect span').textContent = state.configured || state.pending ? 'Reconnect Garmin' : 'Connect Garmin';
        $('#garmin-connect').classList.toggle('primary', (!state.configured && !state.pending) || state.error?.code === 'key-rejected');
        $('#garmin-access').hidden = state.error?.code !== 'permission';
        $('#garmin-history option[value="connection"]').textContent = `From ${state.connectedDate} to today`;
        if (!keyError && !disconnectConfirmed) {
            $('#garmin-key-status').textContent = state.error?.message || (state.configured ? 'Connected on this device' : 'Not connected');
            $('#garmin-key-status').classList.toggle('is-error', !!state.error);
        }
        if (!settingsError) {
            $('#garmin-settings-status').classList.remove('is-error');
            $('#garmin-settings-status').textContent = state.checking ? 'Checking Garmin… Your existing drafts are ready to review.'
                : state.error?.message || (state.enabled ? state.cid ? 'Garmin drafts enabled. Your activity inbox is ready.'
                    : 'Open Peakbagger and sign in to prepare your drafts. Your activities stay in the inbox.' : 'Connect Garmin to start importing activities.');
        }
    };
    const credentialsImported = () => { keyError = settingsError = disconnectConfirmed = false; void refresh().catch(() => {}); };
    document.addEventListener('bpb:credentials-imported', credentialsImported);
    addEventListener('pagehide', () => document.removeEventListener('bpb:credentials-imported', credentialsImported), { once: true });
    let prefs;
    try { prefs = await Settings.requireCurrent(); }
    catch { prefs = { ...Schema.DEFAULTS, enableGarminInbox: false }; settingsUnavailable = true;
        $('#garmin-key-status').textContent = 'Settings could not be read. You can still disconnect Garmin.'; keyError = true; }
    const applyFeature = settings => {
        if (featureEnabled !== settings.enableGarminInbox) { revision++; setDraftCount(null); }
        featureEnabled = settings.enableGarminInbox;
        const revealed = root.hidden;
        root.hidden = false;
        $('#garmin-key').disabled = !featureEnabled;
        $('#garmin-show-key').disabled = !featureEnabled;
        $('#garmin-connect').setAttribute('aria-disabled', String(!featureEnabled));
        $('#garmin-connection-help').textContent = settingsUnavailable
            ? 'Settings could not be read. Reload Settings to connect. You can still disconnect.' : featureEnabled
                ? 'Disconnect removes the saved key and stops imports. Your drafts stay on this device.'
                : 'Garmin imports are off in General. You can still remove the saved key with Disconnect.';
        $('#garmin-preferences').hidden = !featureEnabled || !preferencesRevealed;
        // Native fragment scrolling can run before the async settings read
        // reveals this section. Let the pane's navigation retry that landing
        // once, without moving the reader on subsequent preference updates.
        if (revealed && location.hash === '#capture-garmin') dispatchEvent(new HashChangeEvent('hashchange'));
        void refresh().catch(() => { $('#garmin-disconnect').hidden = false; });
    };
    applyFeature(prefs);
    const unsubscribe = Settings.subscribe(settings => { settingsUnavailable = false; applyFeature(settings); });
    addEventListener('pagehide', unsubscribe, { once: true });
    const selectValue = (select, custom, value) => {
        const known = [...$(select).options].some(option => option.value === String(value));
        $(select).value = known ? String(value) : 'custom'; $(custom).value = value;
    };
    selectValue('#garmin-frequency', '#garmin-custom-hours', prefs.garminCheckHours);
    selectValue('#garmin-recent', '#garmin-custom-days', prefs.garminRecentDays);
    $('#garmin-types').value = prefs.garminActivityTypes;
    $('#garmin-history').value = prefs.garminHistoryStart === 'all' ? 'all' : prefs.garminHistoryStart ? 'date' : 'connection';
    $('#garmin-date').value = prefs.garminHistoryStart === 'all' ? '' : prefs.garminHistoryStart;
    for (const selector of ['#garmin-frequency', '#garmin-recent', '#garmin-history']) $(selector).addEventListener('change', updateChoices);
    updateChoices();
    $('#garmin-show-key').addEventListener('click', () => { const show = $('#garmin-key').type === 'password'; $('#garmin-key').type = show ? 'text' : 'password'; $('#garmin-show-key span').textContent = show ? 'Hide' : 'Show'; $('#garmin-show-key').setAttribute('aria-pressed', String(show)); });
    $('#garmin-key').addEventListener('input', () => { keyError = disconnectConfirmed = false; });
    $('.garmin-key-form').addEventListener('submit', event => {
        event.preventDefault();
        void perform($('#garmin-connect'), $('#garmin-key-status'), async () => {
            const key = $('#garmin-key').value.trim();
            if (!key) throw new Error('Paste your Garmin API key first.');
            // Request from the explicit user gesture, before other awaits.
            if (!await ext.permissions.request({ origins: [GARMIN_PERMISSION] })) throw new Error('Garmin access was not granted.');
            await send({ type: 'GARMIN_CONNECT', key }); $('#garmin-key').value = ''; await refresh({ duringOperation: true });
        });
    });
    $('#garmin-save').addEventListener('click', () => void perform($('#garmin-save'), $('#garmin-settings-status'), async () => {
        const hours = Number($('#garmin-frequency').value === 'custom' ? $('#garmin-custom-hours').value : $('#garmin-frequency').value);
        const days = Number($('#garmin-recent').value === 'custom' ? $('#garmin-custom-days').value : $('#garmin-recent').value);
        const history = $('#garmin-history').value === 'date' ? $('#garmin-date').value : $('#garmin-history').value === 'all' ? 'all' : '';
        const cleaned = Settings.clean({ garminCheckHours: hours, garminRecentDays: days });
        if (cleaned.garminCheckHours !== hours || ($('#garmin-frequency').value === 'custom' && hours === 0)) throw new Error(`Choose a whole interval from 1 to ${Schema.BOUNDS.garminCheckHours.max} hours, or Manual only.`);
        if (cleaned.garminRecentDays !== days) throw new Error(`Choose a whole recent range from 1 to ${Schema.BOUNDS.garminRecentDays.max} days.`);
        if ($('#garmin-history').value === 'date' && (!Schema.validCalendarDate(history) || history > new Date().toLocaleDateString('en-CA'))) throw new Error('Choose a valid history start date that is not in the future.');
        const result = await ext.runtime.sendMessage({ type: 'SETTINGS_PATCH', patch: { garminCheckHours: hours, garminRecentDays: days, garminHistoryStart: history, garminActivityTypes: $('#garmin-types').value } });
        if (!result || result.ok === false) throw new Error('Preferences could not be saved.');
        $('#garmin-settings-status').textContent = 'Preferences saved. Your existing drafts stay in the inbox.';
    }));
    $('#garmin-disconnect').addEventListener('click', () => void perform($('#garmin-disconnect'), $('#garmin-key-status'), async () => {
        const result = await send({ type: 'GARMIN_DISCONNECT' });
        $('#garmin-key').value = '';
        disconnectConfirmed = true; // Hold success only while no key is saved.
        $('#garmin-key-status').textContent = result.accessRemoved === false
            ? 'Disconnected. Remove remaining browser access in extension permissions.'
            : 'Disconnected. Your existing drafts are kept.';
        if (document.activeElement === $('#garmin-disconnect')) {
            (featureEnabled ? $('#garmin-key') : root.querySelector('h3')).focus({ preventScroll: true });
        }
        $('#garmin-disconnect').hidden = true;
        if (state) { state.configured = false; state.enabled = false; }
        $('#garmin-full').disabled = true;
    }, { cleanup: true }));
    root.querySelector('h3').tabIndex = -1;
    for (const [selector, type, extra] of [['#garmin-access', 'GARMIN_ACCESS', {}], ['#garmin-full', 'GARMIN_CHECK', { full: true }], ['#garmin-delete', 'GARMIN_DISCONNECT', { deleteData: true }]]) {
        $(selector).addEventListener('click', () => {
            if (busy || !featureEnabled) return;
            if (extra.deleteData && (pendingDrafts === null
                || !confirm(`Delete ${pendingDrafts} local Garmin drafts and their import history?`))) return;
            void perform($(selector), $('#garmin-settings-status'), async () => {
                if (type === 'GARMIN_ACCESS'
                    && !await ext.permissions.request({ origins: [GARMIN_PERMISSION] })) throw new Error('Garmin access was not granted.');
                await send({ type, ...extra });
                if (extra.deleteData) { keyError = disconnectConfirmed = false; }
                await refresh({ duringOperation: true });
            });
        });
    }
    try { await refresh(); } catch (error) { $('#garmin-key-status').textContent = error.message; $('#garmin-disconnect').hidden = false; }
    const timer = setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 5000);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
if (document.querySelector('[data-garmin-settings]')) void initGarminSettings(document.querySelector('[data-garmin-settings]'));
