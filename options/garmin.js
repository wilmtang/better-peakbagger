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
      <p>Bring your Garmin activities into your inbox automatically.</p>
      <form class="garmin-key-form">
        <div class="garmin-key-label"><label for="garmin-key">Personal API key</label><a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noopener noreferrer" aria-label="Get a Garmin API key (opens in a new tab)">Get a Garmin API key ↗</a></div>
        <p class="garmin-helper" id="garmin-key-help">Create a key in Garmin, then paste it below. Stored only on this device. Keys last up to one year.</p>
        <div class="garmin-key-entry"><input id="garmin-key" type="password" autocomplete="off" spellcheck="false" aria-describedby="garmin-key-help garmin-key-status"><button id="garmin-show-key" type="button" class="panel-button secondary" aria-pressed="false" data-sizing-label="Show"><span>Show</span></button></div>
        <button id="garmin-connect" type="submit" class="panel-button primary" data-sizing-label="Reconnect Garmin"><span>Connect Garmin</span></button>
        <div class="garmin-feedback"><span aria-hidden="true">Garmin didn’t accept this key. Copy the full key or get a new one.</span><span id="garmin-key-status" role="status" aria-atomic="true">Not connected</span></div>
      </form>
      <div id="garmin-preferences" hidden>
        <div class="garmin-pref"><label for="garmin-frequency">Check every<small>How often to check while your browser is running.</small></label><select id="garmin-frequency"><option value="0">Manual only</option><option value="1">Every hour</option><option value="4">Every 4 hours</option><option value="12">Every 12 hours</option><option value="24">Every day</option><option value="custom">Custom…</option></select><label id="garmin-custom-hours-row" hidden>Hours <input id="garmin-custom-hours" type="number" min="1" max="168" value="6"></label></div>
        <div class="garmin-pref"><label for="garmin-recent">Recent check range<small id="garmin-recent-help">How far back each regular check looks.</small></label><select id="garmin-recent"><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option><option value="custom">Custom days…</option></select><label id="garmin-custom-days-row" hidden>Days <input id="garmin-custom-days" type="number" min="1" max="365" value="30"></label></div>
        <div class="garmin-pref"><label for="garmin-history">Full history range<small id="garmin-history-help">Checked weekly to find older activities uploaded late.</small></label><select id="garmin-history"><option value="connection">From connection date</option><option value="date">Choose start date…</option><option value="all">All available history</option></select><label id="garmin-date-row" hidden>From <input id="garmin-date" type="date"></label></div>
        <div class="garmin-pref"><label for="garmin-types">Activities</label><select id="garmin-types"><option value="walking">Hikes, walks &amp; trail runs</option><option value="all">All activities</option></select></div>
        <p class="garmin-helper" id="garmin-scope-note">Ranges use activity dates. Recent checks stay within your full history range. Changing ranges keeps your existing drafts.</p>
        <div class="garmin-actions"><button id="garmin-save" class="panel-button secondary">Save preferences</button><button id="garmin-enable" class="panel-button primary" data-sizing-label="Enable Garmin drafts"><span>Enable Garmin drafts</span></button><a href="inbox.html" class="garmin-inbox-link">Open activity inbox</a></div>
        <p class="garmin-helper">While your browser runs, imports use routes to find peaks on Peakbagger. Drafts and reduced routes stay on this device until completed or removed. You review every ascent before Save.</p>
        <div class="garmin-feedback"><span aria-hidden="true">Open Peakbagger, sign in to your selected climber, then enable Garmin drafts.</span><span id="garmin-settings-status" role="status" aria-atomic="true"></span></div>
        <details><summary>Connection details</summary><p>Full history checks find older uploads within your chosen range. Keys and drafts stay on this device.</p><div class="garmin-actions"><button id="garmin-full" class="panel-button secondary">Check full history</button><button id="garmin-disconnect" class="panel-button secondary">Disconnect</button><button id="garmin-delete" class="panel-button secondary">Delete local Garmin data</button></div><p class="garmin-helper">Disconnect keeps your drafts. Deleting local data removes drafts and import history. Garmin activities and Peakbagger ascents stay in place.</p></details>
      </div>`;
    const $ = selector => root.querySelector(selector);
    root.addEventListener('submit', event => event.preventDefault());
    const send = async message => { const result = await ext.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || 'Garmin could not finish this action. Try again.'); return result; };
    let state; let busy = false; let keyError = false; let settingsError = false;
    const perform = async (button, status, operation) => {
        if (busy) return; busy = true;
        if (status.id === 'garmin-key-status') keyError = false; else settingsError = false;
        button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true'); status.textContent = 'Working…';
        try { await operation(); } catch (error) { status.textContent = error.message;
            if (status.id === 'garmin-key-status') keyError = true; else settingsError = true; }
        finally { busy = false; button.removeAttribute('aria-disabled'); button.removeAttribute('aria-busy'); }
    };
    const updateChoices = () => {
        $('#garmin-custom-hours-row').hidden = $('#garmin-frequency').value !== 'custom';
        $('#garmin-custom-days-row').hidden = $('#garmin-recent').value !== 'custom';
        $('#garmin-date-row').hidden = $('#garmin-history').value !== 'date';
        const manual = $('#garmin-frequency').value === '0';
        $('#garmin-recent-help').textContent = manual ? 'How far back Check now looks.' : 'How far back each regular check looks.';
        $('#garmin-history-help').textContent = manual ? 'Used when you choose Check full history.' : 'Checked weekly to find older activities uploaded late.';
    };
    const refresh = async () => {
        state = await send({ type: 'GARMIN_STATUS' });
        $('#garmin-preferences').hidden = !state.configured && !state.pending;
        $('#garmin-connect span').textContent = state.configured || state.pending ? 'Reconnect Garmin' : 'Connect Garmin';
        $('#garmin-connect').classList.toggle('primary', (!state.configured && !state.pending) || state.error?.code === 'key-rejected');
        $('#garmin-enable').hidden = state.enabled && state.error?.code !== 'permission';
        $('#garmin-enable span').textContent = state.error?.code === 'permission' ? 'Allow Garmin access' : 'Enable Garmin drafts';
        $('#garmin-history option[value="connection"]').textContent = `From ${state.connectedDate} to today`;
        if (!keyError) $('#garmin-key-status').textContent = state.error?.message || (state.configured ? 'Connected on this device' : 'Not connected');
        if (!settingsError) $('#garmin-settings-status').textContent = state.checking ? 'Checking Garmin… Your existing drafts are ready to review.'
            : state.error?.message || (state.enabled ? 'Garmin drafts enabled. Your activity inbox is ready.' : 'Open Peakbagger and sign in before enabling drafts.');
    };
    let prefs;
    try { prefs = await Settings.requireCurrent(); }
    catch { $('#garmin-key-status').textContent = 'Settings could not be read. Reload Settings to connect Garmin.';
        for (const button of root.querySelectorAll('button')) button.disabled = true; return; }
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
    $('#garmin-key').addEventListener('input', () => { keyError = false; });
    $('.garmin-key-form').addEventListener('submit', event => {
        event.preventDefault();
        void perform($('#garmin-connect'), $('#garmin-key-status'), async () => {
            const key = $('#garmin-key').value.trim();
            if (!key) throw new Error('Paste your Garmin API key first.');
            // Request from the explicit user gesture, before other awaits.
            if (!await ext.permissions.request({ origins: [GARMIN_PERMISSION] })) throw new Error('Garmin access was not granted.');
            await send({ type: 'GARMIN_CONNECT', key }); $('#garmin-key').value = ''; await refresh();
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
    for (const [selector, type, extra] of [['#garmin-enable', 'GARMIN_ENABLE', {}], ['#garmin-full', 'GARMIN_CHECK', { full: true }], ['#garmin-disconnect', 'GARMIN_DISCONNECT', {}], ['#garmin-delete', 'GARMIN_DISCONNECT', { deleteData: true }]]) {
        $(selector).addEventListener('click', () => void perform($(selector), $('#garmin-settings-status'), async () => {
            if (extra.deleteData && !confirm(`Delete ${state?.pending || 0} local Garmin drafts and their import history?`)) return;
            if (type === 'GARMIN_ENABLE' && state?.error?.code === 'permission'
                && !await ext.permissions.request({ origins: [GARMIN_PERMISSION] })) throw new Error('Garmin access was not granted.');
            await send({ type, ...extra }); await refresh();
        }));
    }
    try { await refresh(); } catch (error) { $('#garmin-key-status').textContent = error.message; }
    const timer = setInterval(() => { if (!busy && !document.hidden) void refresh().catch(() => {}); }, 5000);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
if (document.querySelector('[data-garmin-settings]')) void initGarminSettings(document.querySelector('[data-garmin-settings]'));
