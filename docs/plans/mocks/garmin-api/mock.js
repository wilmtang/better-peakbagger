// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// All transitions are simulated. No API, storage or downloads. The key-help
// anchor opens Garmin only when the user deliberately follows it.
const $ = selector => document.querySelector(selector);
const screens = ['connect', 'settings', 'inbox', 'review', 'export'];
let timer;
let needsEnable = false;
let replacingKey = false;
const keyMessages = {
    expired: 'Garmin API key expired. Imports paused; your drafts are safe.',
    rejected: 'Garmin needs a new API key. Imports paused; your drafts are safe.',
};
const paused = () => $('#connection-state').value !== 'active';
function keyForm() {
    if (!replacingKey) return;
    $('#connect-title').textContent = 'Update your Garmin key';
    $('#connect-lede').textContent = 'Create a new key to resume imports. Your drafts and settings stay here.';
    $('#connect-tag').textContent = $('#connection-state').value === 'expired' ? 'Key expired' : 'Replace key';
    $('#connect').textContent = 'Reconnect Garmin';
    $('#connect-status').textContent = 'Paste a new key, then reconnect Garmin.';
}
function connectionHealth(state) {
    $('#connection-state').value = state;
    const isPaused = paused();
    for (const selector of ['#settings-check', '#inbox-check', '#full-history', '#history-check', '#refresh-route']) {
        if (isPaused) $(selector).setAttribute('aria-disabled', 'true');
        else $(selector).removeAttribute('aria-disabled');
    }
    for (const selector of ['#settings-update-key', '#inbox-update-key']) $(selector).hidden = !isPaused;
    $('#settings-connection').textContent = isPaused ? '● Imports paused' : '● Connected';
    $('#inbox-connection').textContent = isPaused ? '● Imports paused' : '● Garmin connected';
    for (const selector of ['#settings-connection', '#inbox-connection']) $(selector).classList.toggle('error', isPaused);
    if (isPaused) {
        for (const selector of ['#settings-status', '#inbox-status']) {
            $(selector).textContent = keyMessages[state];
            $(selector).classList.add('error');
        }
    } else {
        $('#inbox-status').classList.remove('error');
        $('#inbox-status').textContent = 'Garmin connected. Your drafts are ready to review.';
        nextCheck();
    }
}
$('#connection-state').addEventListener('change', event => {
    connectionHealth(event.target.value);
    if (location.hash === '#connect' && paused()) { replacingKey = true; keyForm(); }
});
document.querySelectorAll('.update-key').forEach(link => link.addEventListener('click', () => {
    replacingKey = true;
    $('#personal-key').removeAttribute('aria-invalid');
    keyForm();
}));
function showScreen() {
    const name = screens.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'connect';
    if (name === 'connect' && paused()) { replacingKey = true; keyForm(); }
    document.querySelectorAll('[data-screen]').forEach(el => { el.hidden = el.dataset.screen !== name; });
    $('#screen').value = name;
    const nav = name === 'connect' ? 'settings' : name === 'review' ? 'inbox' : name;
    document.querySelectorAll('[data-nav]').forEach(el => {
        if (el.dataset.nav === nav) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
}
addEventListener('hashchange', showScreen);
$('#screen').addEventListener('change', event => { location.hash = event.target.value; });
$('#theme').addEventListener('change', event => { document.documentElement.dataset.bpbTheme = event.target.value; });
$('#show-key').addEventListener('click', () => {
    const show = $('#personal-key').type === 'password';
    $('#personal-key').type = show ? 'text' : 'password';
    $('#show-key').textContent = show ? 'Hide' : 'Show';
    $('#show-key').setAttribute('aria-pressed', String(show));
});
function run(button, status, { pending, success, error, complete, garmin = false, credentialInput = false }) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.dataset.runs = String(Number(button.dataset.runs || 0) + 1);
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    status.classList.remove('error');
    status.textContent = pending;
    if (credentialInput) $('#personal-key').removeAttribute('aria-invalid');
    const outcome = $('#response').value;
    timer = setTimeout(() => {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
        const keyFailure = garmin && ['expired', 'rejected'].includes(outcome);
        status.classList.toggle('error', outcome !== 'success');
        status.textContent = outcome === 'success' ? success : error;
        if (keyFailure && credentialInput) {
            status.textContent = outcome === 'expired' ? 'This key has expired. Get a new key in Garmin and try again.'
                : 'Garmin didn’t accept this key. Copy the full key or get a new one.';
            $('#personal-key').setAttribute('aria-invalid', 'true');
        } else if (keyFailure) connectionHealth(outcome);
        if (outcome === 'success') complete?.();
    }, 1500);
}
const connectionError = 'Could not reach Garmin. Check your connection, then try again.';
$('#connect').addEventListener('click', () => run($('#connect'), $('#connect-status'), {
    pending: 'Checking your Garmin connection…', success: 'Connected. Choose your activity settings.', error: connectionError,
    garmin: true, credentialInput: true,
    complete: () => {
        if (replacingKey && !needsEnable) {
            connectionHealth('active');
            replacingKey = false;
            location.hash = 'inbox';
            return;
        }
        needsEnable = true;
        $('#settings-primary').textContent = 'Enable Garmin drafts';
        $('#settings-status').textContent = 'Choose your preferences, then enable drafts on this device.';
        location.hash = 'settings';
    },
}));
$('#settings-primary').addEventListener('click', () => {
    if (needsEnable) {
        needsEnable = false;
        $('#settings-primary').textContent = 'Open activity inbox';
        nextCheck();
    } else location.hash = 'inbox';
});
function nextCheck() {
    const value = $('#frequency').value;
    $('#custom-row').hidden = value !== 'custom';
    $('#inbox-lede').textContent = value === 'manual' ? 'Your Garmin activities, ready when you check.' : 'Your Garmin activities, imported automatically.';
    $('#inbox-frequency').textContent = value === 'manual' ? 'Manual checks' : value === '4' ? 'Every 4 hours' : 'Custom schedule';
    if (paused()) {
        $('#settings-status').textContent = keyMessages[$('#connection-state').value];
        return;
    }
    $('#settings-status').classList.remove('error');
    $('#settings-status').textContent = value === 'manual' ? 'Automatic checks are off. Use Check now when you’re ready.'
        : value === '4' ? 'Last checked 10:40 AM · Next check about 2:40 PM'
        : value === 'custom' ? 'Choose an interval between 1 and 168 hours.' : `Checks run every ${value} ${value === '1' ? 'hour' : 'hours'} while your browser runs.`;
}
$('#frequency').addEventListener('change', nextCheck);
$('#custom-hours').addEventListener('input', () => {
    if (paused()) return;
    $('#settings-status').textContent = $('#custom-hours').validity.valid ? `Checks run every ${$('#custom-hours').value} hours while your browser runs.` : 'Enter a whole number between 1 and 168 hours.';
});
$('#settings-check').addEventListener('click', () => run($('#settings-check'), $('#settings-status'), {
    garmin: true,
    pending: 'Checking Garmin for new activities…', success: 'Checked just now · Your inbox is up to date.', error: connectionError,
}));
$('#inbox-check').addEventListener('click', () => run($('#inbox-check'), $('#inbox-status'), {
    garmin: true,
    pending: 'Checking Garmin… Your existing drafts are ready to review.', success: 'Checked just now · No new activities.',
    error: 'Could not reach Garmin. Your drafts are safe. Check your connection and try again.',
}));
$('#sign-in').addEventListener('click', () => { $('#inbox-status').textContent = 'Sign in to your selected Peakbagger account to continue.'; });
$('#earlier').addEventListener('click', () => { $('#history-picker').hidden = !$('#history-picker').hidden; });
$('#history-check').addEventListener('click', () => run($('#history-check'), $('#inbox-status'), {
    garmin: true,
    pending: 'Checking earlier activities…', success: 'Earlier activities checked · No new matches in this example.', error: connectionError,
}));
$('#full-history').addEventListener('click', () => run($('#full-history'), $('#settings-status'), {
    garmin: true,
    pending: 'Checking the full selected history…', success: 'History checked · Previously dismissed activities stay excluded.', error: connectionError,
}));
function selection() {
    const count = document.querySelectorAll('.summit-check:checked').length;
    $('#open-drafts').textContent = `Open ${count} ${count === 1 ? 'draft' : 'drafts'}`;
    $('#open-drafts').setAttribute('aria-disabled', String(count === 0));
}
document.querySelectorAll('.summit-check').forEach(el => el.addEventListener('change', selection));
$('#open-drafts').addEventListener('click', () => run($('#open-drafts'), $('#review-status'), {
    pending: 'Preparing your selected drafts…', success: 'Drafts are ready for review. Save each ascent in Peakbagger.',
    error: 'Could not prepare the forms. Your draft is safe. Check your connection and try again.',
}));
$('#refresh-route').addEventListener('click', () => run($('#refresh-route'), $('#review-status'), {
    garmin: true,
    pending: 'Refreshing from Garmin… Your saved draft stays available.', success: 'Activity refreshed · Your summit selections are unchanged.', error: connectionError,
}));
let dismissed = false;
$('#dismiss').addEventListener('click', () => {
    dismissed = !dismissed;
    $('#dismiss').textContent = dismissed ? 'Undo dismiss' : 'Dismiss activity';
    $('#review-status').textContent = dismissed ? 'Activity dismissed. It won’t return on the next check.' : 'Activity restored. Your selections are unchanged.';
});
$('#include-credentials').addEventListener('change', () => {
    $('#credentials-state').textContent = $('#include-credentials').checked ? 'Included' : 'Not included';
    $('#export-status').textContent = $('#include-credentials').checked ? 'This file will include your saved Garmin personal key.' : 'Your current settings will be exported.';
});
$('#export-settings').addEventListener('click', () => {
    $('#export-status').textContent = $('#include-credentials').checked ? 'Settings file ready, including saved credentials. Keep this file private.' : 'Settings file ready, without saved credentials.';
});
addEventListener('pagehide', () => clearTimeout(timer));
// Popup links simulate opening the full workspace, without creating actual tabs.
const inboxMode = new URLSearchParams(location.search).get('inbox');
if (inboxMode === 'empty' || inboxMode === 'disconnected') {
    $('.inbox-list').hidden = true;
    $('#inbox-empty').hidden = false;
    $('.nav-count').hidden = true;
    if (inboxMode === 'disconnected') {
        $('#inbox-empty h2').textContent = 'Connect Garmin to prepare drafts';
        $('#inbox-empty p').textContent = 'Choose which activities to import. You review every ascent before saving.';
        $('#inbox-lede').textContent = 'Connect Garmin to import your activities.';
        $('#inbox-connect').hidden = false;
        $('#inbox-check').hidden = true;
        $('[data-screen="inbox"] .sync-line').hidden = true;
        $('.inbox-feedback').hidden = true;
        $('#earlier').hidden = true;
    }
} else if (inboxMode === 'attention' || inboxMode === 'expired') {
    connectionHealth(inboxMode === 'expired' ? 'expired' : 'rejected');
} else if (inboxMode === 'manual') {
    $('#frequency').value = 'manual'; nextCheck();
} else if (inboxMode === 'checking') {
    $('#inbox-status').textContent = 'Checking Garmin… Your existing drafts are ready to review.';
}
const connectionMode = new URLSearchParams(location.search).get('connection');
if (['expired', 'rejected'].includes(connectionMode)) {
    connectionHealth(connectionMode);
    if (location.hash === '#connect') { replacingKey = true; keyForm(); }
}
showScreen();
