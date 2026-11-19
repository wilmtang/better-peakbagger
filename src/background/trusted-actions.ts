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
    CUSTOM_LAYER_SETTINGS: 'custom-layer-settings',
    CUSTOM_LAYER_ACCESS: 'custom-layer-access',
    CUSTOM_LAYER_REFRESH: 'custom-layer-refresh',
    DRAFT_MANAGER: 'draft-manager',
    CALTOPO_IMPORT: 'caltopo-import',
    ALLTRAILS_IMPORT: 'alltrails-import',
    GAIA_IMPORT: 'gaia-import',
    ONX_IMPORT: 'onx-import',
    PHOTO_EDITOR: 'photo-editor',
    REPORT_PHOTOS: 'report-photos',
    INSTAGRAM_POST: 'instagram-post',
} as const);

export type TrustedActionName = (typeof ACTIONS)[keyof typeof ACTIONS];
export type TrustedWorkflowActionName =
    | typeof ACTIONS.ASCENT_BACKUP
    | typeof ACTIONS.PROFILE_BACKUP
    | typeof ACTIONS.CALTOPO_IMPORT
    | typeof ACTIONS.ALLTRAILS_IMPORT
    | typeof ACTIONS.GAIA_IMPORT
    | typeof ACTIONS.ONX_IMPORT
    | typeof ACTIONS.REPORT_PHOTOS;

export interface TrustedActionStorageArea {
    get(keys: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export interface TrustedActionSender {
    tab?: { id?: unknown } | null;
    frameId?: unknown;
    documentId?: unknown;
    url?: string;
    id?: string;
}

export interface TrustedActionOptions {
    storage?: () => TrustedActionStorageArea;
    isPeakbaggerSender?: (sender: TrustedActionSender | null | undefined) => boolean;
    now?: () => number;
    randomToken?: () => string;
}

export type TrustedActionIssueResult =
    | { ok: true; token: string; expiresAt: number }
    | { ok: false; reason: 'forbidden' };

export type TrustedActionBeginResult =
    | { ok: true; grantToken: string; expiresAt: number }
    | { ok: false; reason: 'forbidden' | 'activation' };

export interface TrustedActionEndResult {
    ok: boolean;
}

interface TrustedActionIdentity {
    tabId: number;
    frameId: number;
    documentId: string | null;
}

interface TrustedActionCapability extends TrustedActionIdentity {
    action: string;
    generation: string;
    expiresAt: number;
}

const ACTION_SET: ReadonlySet<string> = new Set(Object.values(ACTIONS));
const WORKFLOW_ACTIONS: ReadonlySet<string> = new Set([
    ACTIONS.ASCENT_BACKUP,
    ACTIONS.PROFILE_BACKUP,
    ACTIONS.CALTOPO_IMPORT,
    ACTIONS.ALLTRAILS_IMPORT,
    ACTIONS.GAIA_IMPORT,
    ACTIONS.ONX_IMPORT,
    ACTIONS.REPORT_PHOTOS,
]);

const isAction = (value: unknown): value is TrustedActionName =>
    typeof value === 'string' && ACTION_SET.has(value);

const isWorkflowAction = (value: unknown): value is TrustedWorkflowActionName =>
    typeof value === 'string' && WORKFLOW_ACTIONS.has(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const defaultToken = (): string => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const frameId = (sender: TrustedActionSender | null | undefined): number =>
    typeof sender?.frameId === 'number' && Number.isInteger(sender.frameId) ? sender.frameId : 0;

const documentId = (sender: TrustedActionSender | null | undefined): string | null =>
    typeof sender?.documentId === 'string' ? sender.documentId : null;

const generation = (value: unknown): string | null => {
    const text = String(value ?? '');
    return /^[a-zA-Z0-9:_-]{1,100}$/.test(text) ? text : null;
};

export function createTrustedActions({
    storage,
    isPeakbaggerSender,
    now = () => Date.now(),
    randomToken = defaultToken,
}: TrustedActionOptions = {}) {
    if (typeof storage !== 'function' || typeof isPeakbaggerSender !== 'function') {
        throw new TypeError('trusted actions require storage and sender validation');
    }
    const capabilities = new Map<string, TrustedActionCapability>();
    let grantQueue: Promise<unknown> = Promise.resolve();

    const senderIdentity = (sender: TrustedActionSender | null | undefined): TrustedActionIdentity | null => {
        if (!isPeakbaggerSender(sender)) return null;
        const tabId = sender?.tab?.id;
        return typeof tabId === 'number' && Number.isInteger(tabId)
            ? {
                tabId,
                frameId: frameId(sender),
                documentId: documentId(sender),
            }
            : null;
    };
    const sameSender = (
        record: TrustedActionCapability,
        sender: TrustedActionSender | null | undefined,
    ): boolean => {
        const identity = senderIdentity(sender);
        return !!identity && record.tabId === identity.tabId
            && record.frameId === identity.frameId
            && (record.documentId === null || identity.documentId === null
                || record.documentId === identity.documentId);
    };
    const uniqueToken = (records?: Record<string, TrustedActionCapability | undefined>): string => {
        let nextToken: string;
        do { nextToken = randomToken(); } while (capabilities.has(nextToken) || records?.[nextToken]);
        return nextToken;
    };
    const pruneCapabilities = (): void => {
        const current = now();
        for (const [token, record] of capabilities) {
            if (record.expiresAt <= current) capabilities.delete(token);
        }
        while (capabilities.size >= MAX_LIVE_CAPABILITIES) {
            const oldest = capabilities.keys().next();
            if (oldest.done) break;
            capabilities.delete(oldest.value);
        }
    };
    const mutateGrants = <T>(
        mutate: (records: Record<string, TrustedActionCapability | undefined>) => T | Promise<T>,
    ): Promise<T> => {
        const operation = grantQueue.then(async () => {
            const area = storage();
            const raw = (await area.get(STORAGE_KEY))[STORAGE_KEY];
            const records = (asRecord(raw) ?? {}) as Record<string, TrustedActionCapability | undefined>;
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

    const issue = (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
    ): TrustedActionIssueResult => {
        const msg = asRecord(message);
        const action = msg?.action;
        const actionGeneration = generation(msg?.generation);
        const identity = senderIdentity(sender);
        if (!identity || !isAction(action) || !actionGeneration) {
            return { ok: false, reason: 'forbidden' };
        }
        pruneCapabilities();
        const token = uniqueToken();
        const expiresAt = now() + CAPABILITY_TTL_MS;
        capabilities.set(token, { action, generation: actionGeneration, expiresAt, ...identity });
        return { ok: true, token, expiresAt };
    };

    const takeCapability = (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
        expectedAction: string,
    ): TrustedActionCapability | null => {
        pruneCapabilities();
        const msg = asRecord(message);
        const token = typeof msg?.activationToken === 'string' ? msg.activationToken : '';
        const record = capabilities.get(token) || null;
        capabilities.delete(token);
        return record && record.action === expectedAction
            && record.generation === generation(msg?.generation)
            && sameSender(record, sender)
            ? record
            : null;
    };

    const begin = async (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
    ): Promise<TrustedActionBeginResult> => {
        const msg = asRecord(message);
        const action = msg?.action;
        if (!isWorkflowAction(action)) return { ok: false, reason: 'forbidden' };
        const capability = takeCapability(msg, sender, action);
        if (!capability) return { ok: false, reason: 'activation' };
        return mutateGrants<TrustedActionBeginResult>(records => {
            const grantToken = uniqueToken(records);
            const expiresAt = now() + WORKFLOW_TTL_MS;
            records[grantToken] = { ...capability, expiresAt };
            return { ok: true, grantToken, expiresAt };
        });
    };

    const consumeCapability = (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
        action: string,
    ): boolean => !!takeCapability(message, sender, action);

    const consumeGrant = (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
        action: string,
        { oneUse = false }: { oneUse?: boolean } = {},
    ): Promise<boolean> =>
        mutateGrants(records => {
            const msg = asRecord(message);
            const token = typeof msg?.grantToken === 'string' ? msg.grantToken : '';
            const record = records[token];
            if (!record || record.action !== action
                || record.generation !== generation(msg?.generation)
                || !sameSender(record, sender)) {
                if (record) delete records[token];
                return false;
            }
            if (oneUse) delete records[token];
            else record.expiresAt = now() + WORKFLOW_TTL_MS;
            return true;
        });

    const end = (
        message: unknown,
        sender: TrustedActionSender | null | undefined,
    ): Promise<TrustedActionEndResult> => mutateGrants(records => {
        const msg = asRecord(message);
        const token = typeof msg?.grantToken === 'string' ? msg.grantToken : '';
        const record = records[token];
        if (!record || !sameSender(record, sender)
            || record.generation !== generation(msg?.generation)) return { ok: false };
        delete records[token];
        return { ok: true };
    });

    return {
        issue,
        begin,
        end,
        consumeCapability,
        consumeGrant,
        cleanup: (cutoff: number): Promise<void> => mutateGrants(records => {
            for (const [token, record] of Object.entries(records)) {
                if (!record || record.expiresAt <= cutoff) delete records[token];
            }
        }),
        forgetTab(tabId: number): Promise<void> {
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

export type TrustedActionsController = ReturnType<typeof createTrustedActions>;

export const trustedActions = {
    ISSUE_TYPE,
    BEGIN_TYPE,
    END_TYPE,
    STORAGE_KEY,
    CAPABILITY_TTL_MS,
    ACTIONS,
    create: createTrustedActions,
};
