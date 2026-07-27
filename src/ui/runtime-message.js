// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Promise-form runtime messaging is supported by both target browsers: Chrome
// MV3 and Firefox's browser namespace. Normalize teardown and worker failures
// to null so every UI surface fails closed through the same contract.
const send = async (extensionApi, message) => {
    try {
        return (await extensionApi.runtime.sendMessage(message)) || null;
    } catch {
        return null;
    }
};

const sendResult = async (extensionApi, message) => {
    try {
        const response = await extensionApi.runtime.sendMessage(message);
        return response == null
            ? { kind: 'unavailable' }
            : { kind: 'response', value: response };
    } catch {
        return { kind: 'unavailable' };
    }
};

const bind = extensionApi => message => send(extensionApi, message);
const bindResult = extensionApi => message => sendResult(extensionApi, message);

export const runtimeMessage = { send, sendResult, bind, bindResult };
