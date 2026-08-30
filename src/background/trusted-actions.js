// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-use user-activation capabilities for Peakbagger content-script actions
// with external effects. The isolated world alone can call runtime messaging;
// it issues a capability only after observing event.isTrusted. Long profile
// backups exchange that five-second capability for a session-persisted grant
// so MV3 worker suspension cannot turn a real click into an arbitrary retry.

const ISSUE_TYPE = 'TRUSTED_ACTION_ISSUE';
const BEGIN_TYPE = 'TRUSTED_ACTION_BEGIN';
const END_TYPE = 'TRUSTED_ACTION_END';
const STORAGE_KEY = 'bpbTrustedActionGrants';
const CAPABILITY_TTL_MS = 5 * 1000;
const WORKFLOW_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_CAPABILITIES = 128;
const ACTIONS = Object.freeze({
    ASCENT_BACKUP: 'ascent-backup',
    PROFILE_BACKUP: 'profile-backup',
    BETA_SETTINGS: 'beta-settings',
    DRAFT_MANAGER: 'draft-manager',
    PHOTO_EDITOR: 'photo-editor',
});
const ACTION_SET = new Set(Object.values(ACTIONS));
const WORKFLOW_ACTIONS = new Set([ACTIONS.ASCENT_BACKUP, ACTIONS.PROFILE_BACKUP]);

const defaultToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const frameId = sender => Number.isInteger(sender?.frameId) ? sender.frameId : 0;
const documentId = sender => typeof sender?.documentId === 'string' ? sender.documentId : null;
const generation = value => {
    const text = String(value ?? '');
    return /^[a-zA-Z0-9:_-]{1,100}$/.test(text) ? text : null;
};

export function createTrustedActions({
    storage,
    isPeakbaggerSender,
    now = () => Date.now(),
    randomToken = defaultToken,
} = {}) {
    if (typeof storage !== 'function' || typeof isPeakbaggerSender !== 'function') {
        throw new TypeError('trusted actions require storage and sender validation');
    }
    const capabilities = new Map();
    let grantQueue = Promise.resolve();

    const senderIdentity = sender => isPeakbaggerSender(sender) && Number.isInteger(sender?.tab?.id)
        ? {
            tabId: sender.tab.id,
            frameId: frameId(sender),
            documentId: documentId(sender),
        }
        : null;
    const sameSender = (record, sender) => {
        const identity = senderIdentity(sender);
        return !!identity && record.tabId === identity.tabId
            && record.frameId === identity.frameId
            && (record.documentId === null || identity.documentId === null
                || record.documentId === identity.documentId);
    };
    const uniqueToken = records => {
        let token;
        do { token = randomToken(); } while (capabilities.has(token) || records?.[token]);
        return token;
    };
    const pruneCapabilities = () => {
        const current = now();
        for (const [token, record] of capabilities) {
            if (record.expiresAt <= current) capabilities.delete(token);
        }
        while (capabilities.size >= MAX_LIVE_CAPABILITIES) {
            capabilities.delete(capabilities.keys().next().value);
        }
    };
    const mutateGrants = mutate => {
        const operation = grantQueue.then(async () => {
            const area = storage();
            const records = (await area.get(STORAGE_KEY))[STORAGE_KEY] || {};
            const current = now();
            for (const [token, record] of Object.entries(records)) {
                if (!record || record.expiresAt <= current) delete records[token];
            }
            const result = await mutate(records);
            await area.set({ [STORAGE_KEY]: records });
            return result;
        });
        grantQueue = operation.catch(() => {});
        return operation;
    };

    const issue = (message, sender) => {
        const action = message?.action;
        const actionGeneration = generation(message?.generation);
        const identity = senderIdentity(sender);
        if (!identity || !ACTION_SET.has(action) || !actionGeneration) {
            return { ok: false, reason: 'forbidden' };
        }
        pruneCapabilities();
        const token = uniqueToken();
        const expiresAt = now() + CAPABILITY_TTL_MS;
        capabilities.set(token, { action, generation: actionGeneration, expiresAt, ...identity });
        return { ok: true, token, expiresAt };
    };

    const takeCapability = (message, sender, expectedAction) => {
        pruneCapabilities();
        const token = typeof message?.activationToken === 'string' ? message.activationToken : '';
        const record = capabilities.get(token) || null;
        capabilities.delete(token);
        return record && record.action === expectedAction
            && record.generation === generation(message?.generation)
            && sameSender(record, sender)
            ? record
            : null;
    };

    const begin = async (message, sender) => {
        const action = message?.action;
        if (!WORKFLOW_ACTIONS.has(action)) return { ok: false, reason: 'forbidden' };
        const capability = takeCapability(message, sender, action);
        if (!capability) return { ok: false, reason: 'activation' };
        return mutateGrants(records => {
            const grantToken = uniqueToken(records);
            const expiresAt = now() + WORKFLOW_TTL_MS;
            records[grantToken] = { ...capability, expiresAt };
            return { ok: true, grantToken, expiresAt };
        });
    };

    const consumeCapability = (message, sender, action) =>
        !!takeCapability(message, sender, action);

    const consumeGrant = (message, sender, action, { oneUse = false } = {}) =>
        mutateGrants(records => {
            const token = typeof message?.grantToken === 'string' ? message.grantToken : '';
            const record = records[token];
            if (!record || record.action !== action
                || record.generation !== generation(message?.generation)
                || !sameSender(record, sender)) {
                if (record) delete records[token];
                return false;
            }
            if (oneUse) delete records[token];
            else record.expiresAt = now() + WORKFLOW_TTL_MS;
            return true;
        });

    const end = (message, sender) => mutateGrants(records => {
        const token = typeof message?.grantToken === 'string' ? message.grantToken : '';
        const record = records[token];
        if (!record || !sameSender(record, sender)
            || record.generation !== generation(message?.generation)) return { ok: false };
        delete records[token];
        return { ok: true };
    });

    return {
        issue,
        begin,
        end,
        consumeCapability,
        consumeGrant,
        cleanup: cutoff => mutateGrants(records => {
            for (const [token, record] of Object.entries(records)) {
                if (!record || record.expiresAt <= cutoff) delete records[token];
            }
        }),
        forgetTab(tabId) {
            for (const [token, record] of capabilities) {
                if (record.tabId === tabId) capabilities.delete(token);
            }
            return mutateGrants(records => {
                for (const [token, record] of Object.entries(records)) {
                    if (record?.tabId === tabId) delete records[token];
                }
            });
        },
    };
}

export const trustedActions = {
    ISSUE_TYPE,
    BEGIN_TYPE,
    END_TYPE,
    STORAGE_KEY,
    CAPABILITY_TTL_MS,
    WORKFLOW_TTL_MS,
    ACTIONS,
    create: createTrustedActions,
};
