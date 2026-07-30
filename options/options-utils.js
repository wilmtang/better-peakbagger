// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const githubRepoName = status => status?.repo?.fullName
    || (status?.repo?.owner && status?.repo?.name
        ? `${status.repo.owner}/${status.repo.name}`
        : 'the connected repository');

const withBusy = async ({ isBusy, setBusy }, operation) => {
    if (isBusy()) return;
    setBusy(true);
    try {
        await operation();
    } finally {
        setBusy(false);
    }
};

const logMissingElements = (surface, elements) => {
    const missing = Object.entries(elements)
        .filter(([, value]) => Array.isArray(value)
            ? value.length === 0 || value.some(element => !element)
            : !value)
        .map(([name]) => name);
    if (!missing.length) return false;
    console.error(`Better Peakbagger ${surface} unavailable; missing: ${missing.join(', ')}`);
    return true;
};

// The panel surfaces' only transient channel, and most of its traffic reports a
// failure or blocks the action. Successes confirm and fade; failures go to the
// alert region, keep the danger colour, and stay until the user dismisses them
// or the next report replaces them. Two sibling live regions rather than one
// whose role/aria-live is rewritten per message: assistive technology does not
// reliably pick up a role change on a live element. Shared so a second page
// cannot ship a third variant of that contract.
const createStatusFlash = ({ statusEl, statusErrorEl, statusErrorTextEl, statusErrorDismissEl }) => {
    let statusTimer = null;
    const dismissStatus = () => {
        clearTimeout(statusTimer);
        statusTimer = null;
        statusEl.classList.remove('show');
        statusErrorEl.classList.remove('show');
        statusErrorEl.hidden = true;
    };
    const flash = (msg = 'Saved', { error = false } = {}) => {
        dismissStatus();
        if (error) {
            statusErrorTextEl.textContent = msg;
            statusErrorEl.hidden = false;
            statusErrorEl.classList.add('show');
            return;
        }
        statusEl.textContent = msg;
        statusEl.classList.add('show');
        statusTimer = setTimeout(() => statusEl.classList.remove('show'), 1200);
    };
    statusErrorDismissEl.addEventListener('click', dismissStatus);
    return { flash, dismissStatus };
};

export const optionsUtils = { githubRepoName, withBusy, logMissingElements, createStatusFlash };
