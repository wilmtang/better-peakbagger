// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// All transitions are simulated. No network, storage, credentials, downloads or tabs.
const $ = selector => document.querySelector(selector);
const screens = ['connect', 'settings', 'inbox', 'review', 'export'];
let timer;
let needsEnable = false;
function showScreen() {
    const name = screens.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'connect';
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
});
function run(button, status, { pending, success, error, complete }) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    status.classList.remove('error');
    status.textContent = pending;
    const outcome = $('#response').value;
    timer = setTimeout(() => {
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-busy');
        status.classList.toggle('error', outcome === 'error');
        status.textContent = outcome === 'error' ? error : success;
        if (outcome === 'success') complete?.();
    }, 1500);
}
const connectionError = 'Could not reach Garmin. Check your connection, then try again.';
$('#connect').addEventListener('click', () => run($('#connect'), $('#connect-status'), {
    pending: 'Checking your Garmin connection…', success: 'Connected. Choose your activity settings.', error: connectionError,
    complete: () => {
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
    $('#settings-status').classList.remove('error');
    $('#settings-status').textContent = value === 'manual' ? 'Automatic checks are off. Use Check now when you’re ready.'
        : value === '4' ? 'Last checked 10:40 AM · Next check about 2:40 PM'
        : value === 'custom' ? 'Choose an interval between 1 and 168 hours.' : `Checks run every ${value} ${value === '1' ? 'hour' : 'hours'} while your browser runs.`;
}
$('#frequency').addEventListener('change', nextCheck);
$('#custom-hours').addEventListener('input', () => {
    $('#settings-status').textContent = $('#custom-hours').validity.valid ? `Checks run every ${$('#custom-hours').value} hours while your browser runs.` : 'Enter a whole number between 1 and 168 hours.';
});
$('#settings-check').addEventListener('click', () => run($('#settings-check'), $('#settings-status'), {
    pending: 'Checking Garmin for new activities…', success: 'Checked just now · Your inbox is up to date.', error: connectionError,
}));
$('#inbox-check').addEventListener('click', () => run($('#inbox-check'), $('#inbox-status'), {
    pending: 'Checking Garmin… Your existing drafts are ready to review.', success: 'Checked just now · No new activities.',
    error: 'Could not reach Garmin. Your drafts are safe. Check your connection and try again.',
}));
$('#sign-in').addEventListener('click', () => { $('#inbox-status').textContent = 'Sign in to your selected Peakbagger account to continue.'; });
$('#earlier').addEventListener('click', () => { $('#history-picker').hidden = !$('#history-picker').hidden; });
$('#history-check').addEventListener('click', () => run($('#history-check'), $('#inbox-status'), {
    pending: 'Checking earlier activities…', success: 'Earlier activities checked · No new matches in this example.', error: connectionError,
}));
$('#full-history').addEventListener('click', () => run($('#full-history'), $('#settings-status'), {
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
showScreen();
