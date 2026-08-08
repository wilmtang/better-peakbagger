// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-use authorization for actions that can contact terrain providers. The
// Peakbagger page cannot call extension runtime messaging, so only the isolated
// bridge can issue a capability after it observes a trusted control event. The
// extension frame then consumes that opaque capability before MapLibre starts.

const ISSUE_TYPE = 'TERRAIN_ACTIVATION_ISSUE';
const CONSUME_TYPE = 'TERRAIN_ACTIVATION_CONSUME';
const TTL_MS = 5 * 1000;
const MAX_LIVE_CAPABILITIES = 128;
const ACTIONS = new Set(['init', 'prefetch']);

const defaultToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const senderFrameId = sender => Number.isInteger(sender?.frameId) ? sender.frameId : 0;
const senderDocumentId = sender => typeof sender?.documentId === 'string' ? sender.documentId : null;

export function createTerrainActivation({
    isPeakbaggerSender,
    isTerrainFrameSender,
    now = () => Date.now(),
    randomToken = defaultToken,
} = {}) {
    if (typeof isPeakbaggerSender !== 'function' || typeof isTerrainFrameSender !== 'function') {
        throw new TypeError('terrain activation requires sender validators');
    }
    const capabilities = new Map();

    const prune = () => {
        const current = now();
        for (const [token, capability] of capabilities) {
            if (capability.expiresAt <= current) capabilities.delete(token);
        }
        while (capabilities.size >= MAX_LIVE_CAPABILITIES) {
            capabilities.delete(capabilities.keys().next().value);
        }
    };

    const issue = (message, sender) => {
        const action = message?.action;
        if (!ACTIONS.has(action) || !isPeakbaggerSender(sender)
            || !Number.isInteger(sender?.tab?.id)) {
            return { ok: false, reason: 'forbidden' };
        }
        prune();
        let token;
        do { token = randomToken(); } while (capabilities.has(token));
        const expiresAt = now() + TTL_MS;
        capabilities.set(token, {
            action,
            expiresAt,
            tabId: sender.tab.id,
            frameId: senderFrameId(sender),
            documentId: senderDocumentId(sender),
        });
        return { ok: true, token, expiresAt };
    };

    // Looking up a token consumes it before any comparison. A stolen or
    // mismatched capability can deny one activation, but can never be probed or
    // replayed until it happens to match a later tab/frame.
    const take = (token, action) => {
        prune();
        if (typeof token !== 'string' || !token) return null;
        const capability = capabilities.get(token) || null;
        capabilities.delete(token);
        return capability && capability.action === action ? capability : null;
    };

    const consumeFrame = (message, sender) => {
        if (!isTerrainFrameSender(sender) || !Number.isInteger(sender?.tab?.id)) {
            return { ok: false, reason: 'forbidden' };
        }
        const capability = take(message?.token, message?.action);
        if (!capability || capability.action !== 'init'
            || capability.tabId !== sender.tab.id) {
            return { ok: false, reason: 'activation' };
        }
        return { ok: true };
    };

    const consumePrefetch = (token, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender?.tab?.id)) return false;
        const capability = take(token, 'prefetch');
        if (!capability || capability.tabId !== sender.tab.id
            || capability.frameId !== senderFrameId(sender)) return false;
        const documentId = senderDocumentId(sender);
        return capability.documentId === null || documentId === null
            || capability.documentId === documentId;
    };

    return {
        issue,
        consumeFrame,
        consumePrefetch,
        forgetTab(tabId) {
            for (const [token, capability] of capabilities) {
                if (capability.tabId === tabId) capabilities.delete(token);
            }
        },
    };
}

export const terrainActivation = {
    ISSUE_TYPE,
    CONSUME_TYPE,
    TTL_MS,
    create: createTerrainActivation,
};
