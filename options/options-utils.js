// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const send = (extensionApi, message) => new Promise(resolve => {
    try {
        extensionApi.runtime.sendMessage(message, response => {
            void extensionApi.runtime.lastError;
            resolve(response || null);
        });
    } catch {
        resolve(null);
    }
});

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

export const optionsUtils = { send, githubRepoName, withBusy };
