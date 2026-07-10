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
    const wordsEl = document.getElementById('minwords');
    const betaTrEl = document.getElementById('beta-tr');
    const betaTrWordsEl = document.getElementById('beta-tr-words');
    const betaGpsEl = document.getElementById('beta-gps');
    const betaLinkEl = document.getElementById('beta-link');
    const statusEl = document.getElementById('status');

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
        wordsEl.value = String(settings.defaultMinTrWords);
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
    wordsEl.addEventListener('change', () => {
        const value = Math.max(1, parseInt(wordsEl.value, 10) || 1);
        wordsEl.value = String(value);
        save({ defaultMinTrWords: value });
    });

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
