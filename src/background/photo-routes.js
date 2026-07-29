// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trusted photo-page credential and report-return routes.

import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';
import { photoLibrary as Library } from '../photos/photo-library.js';

const RETURN_CONTEXTS_KEY = 'bpbPhotoEditorReturns';
const RETURN_TTL_MS = 2 * 60 * 60 * 1000;
const IMGBB_PERMISSION = Object.freeze({ origins: ['https://api.imgbb.com/*'] });

const cleanIdentityNumber = (value, { signed = false } = {}) => {
    if (value == null) return null;
    const number = typeof value === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(value)
        ? Number(value)
        : value;
    return Number.isSafeInteger(number) && (signed || number > 0) ? number : null;
};

const cleanDraftIdentity = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cid = cleanIdentityNumber(value.cid);
    const aid = cleanIdentityNumber(value.aid);
    const pid = cleanIdentityNumber(value.pid, { signed: true });
    if (value.cid != null && cid == null) return null;
    if (value.aid != null && aid == null) return null;
    if (value.pid != null && pid == null) return null;
    return { cid, aid, pid };
};

const cleanPublicInsertion = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const localPhotoId = typeof value.localPhotoId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.localPhotoId)
        ? value.localPhotoId
        : null;
    const decorative = typeof value.decorative === 'boolean' ? value.decorative : null;
    const alt = String(value.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, Library.ALT_LIMIT);
    let url;
    try {
        const parsed = new URL(value.url);
        url = parsed.protocol === 'https:' && !parsed.username && !parsed.password
            ? parsed.toString()
            : null;
    } catch { url = null; }
    return localPhotoId && decorative != null && (decorative || alt) && url
        ? { localPhotoId, url, alt: decorative ? '' : alt, decorative }
        : null;
};

const defaultToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

export function createPhotoRoutes({
    ext,
    storage,
    now = () => Date.now(),
    isPeakbaggerSender,
    mutateMap,
    readMap,
    randomToken = defaultToken,
    keyStore = ImgbbAuth.keyStore,
} = {}) {
    if (!ext || !storage || !isPeakbaggerSender || !mutateMap || !readMap || !keyStore) {
        throw new TypeError('photo routes require extension, storage, and sender dependencies');
    }

    // The shared worker must still boot when an embedded/test environment does
    // not expose extension-page URLs. Photo routes remain unavailable and fail
    // closed in that environment.
    const packagedPage = page => {
        const base = typeof ext.runtime?.getURL === 'function' ? ext.runtime.getURL(page) : null;
        return sender => {
            if (!base) return false;
            try {
                const actual = new URL(sender?.url || '');
                const expected = new URL(base);
                return actual.origin === expected.origin
                    && actual.pathname === expected.pathname
                    && Number.isInteger(sender?.tab?.id);
            } catch { return false; }
        };
    };
    const photoPageBase = typeof ext.runtime?.getURL === 'function'
        ? ext.runtime.getURL('photos/photos.html')
        : null;
    const isPhotoPage = packagedPage('photos/photos.html');
    const isOptionsPage = packagedPage('options/options.html');
    // The key can be configured from either extension-owned surface, because
    // Settings is where users expect to find it. Reading it back stays with the
    // photo page alone: that is the only page that uploads, and widening the
    // lease would hand the credential to a surface with no use for it.
    const isCredentialPage = sender => isPhotoPage(sender) || isOptionsPage(sender);

    const permissionGranted = async () => !!(ext.permissions?.contains
        && await ext.permissions.contains(IMGBB_PERMISSION));

    const status = async (_message, sender) => {
        if (!isCredentialPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const stored = await keyStore.read();
        return {
            ok: true,
            configured: !!stored,
            savedAt: stored?.savedAt || null,
            permissionGranted: await permissionGranted(),
        };
    };

    const saveKey = async (message, sender) => {
        if (!isCredentialPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        try {
            const result = await keyStore.setKey(message.key, new Date(now()).toISOString());
            return { ok: true, ...result };
        } catch {
            return {
                ok: false,
                error: { code: 'invalid-key', message: 'Enter a valid ImgBB API key.' },
            };
        }
    };

    const removeKey = async (_message, sender) => {
        if (!isCredentialPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        await keyStore.clear();
        return { ok: true };
    };

    const leaseKey = async (_message, sender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const key = await keyStore.getKey();
        return key
            ? { ok: true, key }
            : { ok: false, error: { code: 'not-configured', message: 'Enter an ImgBB API key.' } };
    };

    const openEditor = async (message, sender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: { code: 'forbidden', message: 'Open the photo editor from a Peakbagger report.' },
            };
        }
        const identity = cleanDraftIdentity(message.identity || {});
        const mode = message.mode === 'library' ? 'library' : 'edit';
        if (!identity) return { ok: false, error: { code: 'invalid-context' } };
        const token = randomToken();
        const createdAt = now();
        await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
            contexts[token] = {
                token,
                sourceTabId: sender.tab.id,
                sourceFrameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
                editorTabId: null,
                identity,
                createdAt,
                expiresAt: createdAt + RETURN_TTL_MS,
                consumed: false,
            };
        });
        let tab;
        try {
            const url = new URL(photoPageBase);
            url.searchParams.set('mode', mode);
            url.searchParams.set('returnToken', token);
            tab = await ext.tabs.create({ url: url.toString() });
            if (!Number.isInteger(tab?.id)) throw new Error('Photo editor tab did not open.');
            await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
                if (contexts[token]) contexts[token].editorTabId = tab.id;
            });
        } catch {
            await mutateMap(RETURN_CONTEXTS_KEY, contexts => { delete contexts[token]; });
            return {
                ok: false,
                error: { code: 'open-failed', message: 'The photo editor could not be opened.' },
            };
        }
        return { ok: true, tabId: tab.id };
    };

    const insertResult = async (message, sender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const token = typeof message.returnToken === 'string' ? message.returnToken : '';
        const insertion = cleanPublicInsertion(message);
        if (!token || !insertion) return { ok: false, error: { code: 'invalid-result' } };

        const context = await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
            const candidate = contexts[token];
            if (!candidate || candidate.consumed || candidate.expiresAt <= now()
                || candidate.editorTabId !== sender.tab.id) return null;
            candidate.consumed = true;
            return { ...candidate };
        });
        if (!context) {
            return {
                ok: false,
                error: { code: 'expired-context', message: 'The original report is no longer available.' },
            };
        }
        try {
            const response = await ext.tabs.sendMessage(context.sourceTabId, {
                type: 'PHOTO_INSERT_RESULT',
                returnToken: token,
                ...insertion,
            }, { frameId: context.sourceFrameId });
            return response?.ok
                ? { ok: true, identity: context.identity }
                : {
                    ok: false,
                    error: {
                        code: 'insert-failed',
                        message: 'The photo was uploaded but could not be inserted into the report.',
                    },
                };
        } catch {
            return {
                ok: false,
                error: {
                    code: 'insert-failed',
                    message: 'The photo was uploaded, but the original report tab is no longer available.',
                },
            };
        }
    };

    const cleanup = cutoff => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
        Object.entries(contexts).forEach(([token, context]) => {
            if (!context || context.expiresAt <= cutoff || context.consumed) delete contexts[token];
        });
    });

    const forgetTab = tabId => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
        Object.entries(contexts).forEach(([token, context]) => {
            if (context?.sourceTabId === tabId || context?.editorTabId === tabId) delete contexts[token];
        });
    });

    return {
        handlers: {
            PHOTO_IMGBB_STATUS: status,
            PHOTO_IMGBB_SAVE_KEY: saveKey,
            PHOTO_IMGBB_REMOVE_KEY: removeKey,
            PHOTO_IMGBB_LEASE_KEY: leaseKey,
            PHOTO_EDITOR_OPEN: openEditor,
            PHOTO_INSERT_COMMIT: insertResult,
        },
        cleanup,
        forgetTab,
        isPhotoPage,
    };
}

export const photoRoutes = {
    RETURN_CONTEXTS_KEY,
    RETURN_TTL_MS,
    IMGBB_PERMISSION,
    cleanDraftIdentity,
    cleanPublicInsertion,
};
