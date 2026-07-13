// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options page controller.

(() => {
    'use strict';
    const S = window.BPBSettings;
    const root = document.documentElement;
    const unitsEl = document.getElementById('units');
    const themeEl = document.getElementById('theme');
    const chartSeriesEl = document.getElementById('chart-series');
    const betaTrEl = document.getElementById('beta-tr');
    const betaTrWordsEl = document.getElementById('beta-tr-words');
    const betaGpsEl = document.getElementById('beta-gps');
    const betaLinkEl = document.getElementById('beta-link');
    const statusEl = document.getElementById('status');
    const stravaTokenEl = document.getElementById('strava-token');
    const stravaTestEl = document.getElementById('strava-test');
    const stravaResultEl = document.getElementById('strava-result');

    const applyTheme = theme => root.setAttribute('data-bpb-theme', S.resolveTheme(theme));

    let statusTimer = null;
    const flash = (msg = 'Saved') => {
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1200);
    };

    const populate = settings => {
        unitsEl.value = settings.units;
        themeEl.value = settings.theme;
        chartSeriesEl.value = settings.chartDefaultSeries;
        betaTrEl.checked = settings.betaTr;
        betaTrWordsEl.value = String(settings.betaTrMinWords);
        betaTrWordsEl.disabled = !settings.betaTr;
        betaGpsEl.checked = settings.betaGps;
        betaLinkEl.checked = settings.betaLink;
        applyTheme(settings.theme);
    };

    const save = async patch => {
        const next = await S.set(patch);
        applyTheme(next.theme);
        flash();
        return next;
    };

    unitsEl.addEventListener('change', () => save({ units: unitsEl.value }));
    themeEl.addEventListener('change', () => save({ theme: themeEl.value }));
    chartSeriesEl.addEventListener('change', () => save({ chartDefaultSeries: chartSeriesEl.value }));

    // "Has beta" definition. An empty definition is never valid: block
    // unchecking the last signal instead of silently resetting later.
    const betaSignals = [[betaTrEl, 'betaTr'], [betaGpsEl, 'betaGps'], [betaLinkEl, 'betaLink']];
    for (const [el, key] of betaSignals) {
        el.addEventListener('change', () => {
            if (!betaTrEl.checked && !betaGpsEl.checked && !betaLinkEl.checked) {
                el.checked = true;
                flash('Keep at least one signal checked');
                return;
            }
            betaTrWordsEl.disabled = !betaTrEl.checked;
            save({ [key]: el.checked });
        });
    }
    betaTrWordsEl.addEventListener('change', () => {
        const value = Math.max(1, parseInt(betaTrWordsEl.value, 10) || 1);
        betaTrWordsEl.value = String(value);
        save({ betaTrMinWords: value });
    });

    stravaTestEl.addEventListener('click', async () => {
        const token = stravaTokenEl.value.trim();
        if (!token) {
            stravaResultEl.textContent = 'Paste an access token first.';
            return;
        }

        stravaTestEl.disabled = true;
        stravaResultEl.textContent = 'Testing…';
        const request = path => fetch(`https://www.strava.com/api/v3${path}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        try {
            const athleteResponse = await request('/athlete');
            if (!athleteResponse.ok) throw new Error(`Token rejected (${athleteResponse.status}).`);
            const athlete = await athleteResponse.json();

            const activitiesResponse = await request('/athlete/activities?per_page=1');
            if ([401, 403].includes(activitiesResponse.status)) throw new Error('Token is valid but lacks activity:read.');
            if (!activitiesResponse.ok) throw new Error(`Activity request failed (${activitiesResponse.status}).`);
            const activities = await activitiesResponse.json();
            const latest = activities[0];
            const who = athlete.firstname || athlete.username || `athlete ${athlete.id}`;
            stravaResultEl.textContent = latest
                ? `Token works for ${who}. Latest activity: ${latest.name}.`
                : `Token works for ${who}. No activities were returned.`;
        } catch (error) {
            stravaResultEl.textContent = error.message || 'Strava request failed.';
        } finally {
            stravaTokenEl.value = '';
            stravaTestEl.disabled = false;
        }
    });

    // Keep in sync if changed elsewhere (another tab / an inline control).
    S.subscribe(settings => populate(settings));

    // Reflect the system theme live while "Follow system" is selected.
    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (themeEl.value === 'system') applyTheme('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }

    S.get().then(populate);
})();
