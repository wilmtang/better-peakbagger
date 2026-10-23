// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Documentation only: local counts and navigation; no extension or network APIs.
const $ = selector => document.querySelector(selector);
let timer;
const params = new URLSearchParams(location.search);
for (const [key, selector] of [['state', '#popup-state'], ['context', '#popup-context'], ['theme', '#popup-theme']]) {
    const value = params.get(key);
    if ([...$(selector).options].some(option => option.value === value)) $(selector).value = value;
}
function inboxState(announce = false) {
    const state = $('#popup-state').value;
    const count = state === 'many' ? 125 : ['ready', 'checking', 'attention'].includes(state) ? 3 : 0;
    $('#popup-count').hidden = state === 'empty' || state === 'disconnected';
    $('#popup-count').textContent = state === 'unknown' ? '—' : count > 99 ? '99+' : String(count);
    const description = state === 'unknown' ? 'pending count unavailable' : `${count} pending ${count === 1 ? 'activity' : 'activities'}`;
    $('#popup-inbox').setAttribute('aria-label', `Activity inbox, ${description}`);
    if (announce) $('#popup-count-status').textContent = `Activity inbox: ${description}.`;
    // Connectivity and refresh never gate access to already stored drafts.
}
function context() {
    const value = $('#popup-context').value;
    const content = {
        activity: ['Garmin Connect activity', 'Prepare this activity', 'Find summit matches from the activity open in this tab.', 'Capture this activity'],
        unsupported: ['Your activity drafts', 'Capture from an activity page', 'Open one of your Garmin or Strava activities to prepare summit drafts.', ''],
        working: ['Garmin Connect activity', 'Finding summit matches…', 'This capture continues while you review your saved activities.', 'Cancel capture'],
        'capture-error': ['Garmin Connect activity', 'Open Peakbagger to continue', 'Sign in to your Peakbagger account, then retry this capture.', 'Open Peakbagger'],
    }[value];
    $('#provider-label').textContent = content[0];
    $('#popup-capture-title').textContent = content[1];
    $('#popup-capture-detail').textContent = content[2];
    $('#popup-capture').textContent = content[3];
    $('#popup-capture').hidden = !content[3];
    $('#popup-capture-card').classList.toggle('error', value === 'capture-error');
}
$('#popup-state').addEventListener('change', () => inboxState(true));
$('#popup-context').addEventListener('change', context);
$('#popup-theme').addEventListener('change', event => { document.documentElement.dataset.bpbTheme = event.target.value; });
$('#popup-inbox').addEventListener('click', () => {
    const button = $('#popup-inbox');
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    button.dataset.opens = String(Number(button.dataset.opens || 0) + 1);
    $('#popup-inbox-status').classList.remove('error');
    $('#popup-inbox-status').textContent = 'Opening your activity inbox…';
    $('.inbox-indicator svg').toggleAttribute('hidden', true);
    $('.inbox-spinner').hidden = false;
    const outcome = $('#popup-response').value;
    timer = setTimeout(() => {
        button.removeAttribute('aria-disabled'); button.removeAttribute('aria-busy');
        $('.inbox-indicator svg').toggleAttribute('hidden', false); $('.inbox-spinner').hidden = true;
        if (outcome === 'error') {
            $('#popup-inbox-status').classList.add('error');
            $('#popup-inbox-status').textContent = 'Couldn’t open inbox. Try again.';
        } else {
            location.href = `index.html?inbox=${encodeURIComponent($('#popup-state').value)}#inbox`;
        }
    }, 1200);
});
$('#open-settings').addEventListener('click', () => { location.href = 'index.html#settings'; });
$('#popup-capture').addEventListener('click', () => {
    $('#popup-context').value = $('#popup-context').value === 'working' ? 'activity' : 'working';
    context();
});
addEventListener('pagehide', () => clearTimeout(timer));
document.documentElement.dataset.bpbTheme = $('#popup-theme').value;
inboxState(); context();
