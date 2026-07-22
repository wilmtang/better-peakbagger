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

export const optionsUtils = { githubRepoName, withBusy, logMissingElements };
