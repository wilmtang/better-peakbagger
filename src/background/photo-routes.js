// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trusted photo-page credential and report-return routes.

import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';
import { photoLibrary as Library } from '../photos/photo-library.js';
import { sanitizeReportDimension } from '../reports/report-markup.js';
import { createReportPhotoService, reportPhotoOwner } from './report-photo-service.js';
import { reportPhoto as PendingPhoto } from '../photos/report-photo.js';
import { trustedActions as TrustedActions } from './trusted-actions.js';

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

const cleanSourceUrl = value => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        url.hash = '';
        return url.toString();
    } catch { return null; }
};

const cleanPublicInsertion = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const localPhotoId = typeof value.localPhotoId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.localPhotoId)
        ? value.localPhotoId
        : null;
    const alt = String(value.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, Library.ALT_LIMIT);
    let url;
    try {
        const parsed = new URL(value.url);
        url = parsed.protocol === 'https:' && !parsed.username && !parsed.password
            ? parsed.toString()
            : null;
    } catch { url = null; }
    const displayWidth = sanitizeReportDimension(value.displayWidth);
    // An empty `alt` is a valid decorative-image description, so it does not
    // invalidate the insertion; the id and HTTPS URL still must be sound. A
    // malformed optional display width is discarded rather than losing an
    // already-uploaded photo.
    return localPhotoId && url ? {
        localPhotoId,
        url,
        alt,
        ...(displayWidth ? { displayWidth } : {}),
    } : null;
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
    trustedActions,
    buildOpenResponse = tabId => ({ ok: true, tabId }),
    logCleanupFailure = message => console.error(message),
} = {}) {
    if (!ext || !storage || !isPeakbaggerSender || !mutateMap || !readMap || !keyStore
        || !trustedActions
        || typeof buildOpenResponse !== 'function' || typeof logCleanupFailure !== 'function') {
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
                // Protocol and host are compared outright: only special schemes
                // are specified to produce an `origin`, so an extension URL's
                // is browser-defined and serializes as "null" in a spec-strict
                // parser, which would admit another extension's same-path page.
                return actual.protocol === expected.protocol
                    && actual.host === expected.host
                    && actual.origin === expected.origin
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

    const reportPhotos = createReportPhotoService({ keyStore, permissionGranted });
    const reportOwner = sender => isPeakbaggerSender(sender) && Number.isInteger(sender.tab?.id)
        ? reportPhotoOwner(sender.url) : null;
    const reportRoute = operation => async (message, sender) => {
        const owner = reportOwner(sender);
        if (!owner) return { ok: false, error: { code: 'forbidden' } };
        try { return { ok: true, ...await operation(message, sender, owner) }; }
        catch (error) { return { ok: false, error: { message: error.message } }; }
    };
    const reportStatus = reportRoute(async () => ({
        configured: !!await keyStore.read(), permissionGranted: await permissionGranted(),
    }));
    const createReportPhoto = reportRoute(async (message, sender, owner) => {
        if (!trustedActions.consumeCapability(message, sender, TrustedActions.ACTIONS.REPORT_PHOTOS)) {
            throw new Error('Paste a photo into the report to add it.');
        }
        if (!await keyStore.read() || !await permissionGranted()) {
            throw new Error('Set up ImgBB in Settings before pasting photos.');
        }
        return reportPhotos.create(owner, message);
    });
    const readReportPhoto = reportRoute(async (message, sender, owner) => {
        const { image } = await reportPhotos.read(owner, message.localPhotoId);
        return { dataUrl: image.dataUrl };
    });
    const uploadReportPhoto = reportRoute(async (message, sender, owner) => {
        if (!await trustedActions.consumeGrant(message, sender, TrustedActions.ACTIONS.REPORT_PHOTOS)) {
            throw new Error('Use Save Ascent to upload report photos.');
        }
        return reportPhotos.uploadOne(owner, message.localPhotoId);
    });

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
        const sourceUrl = cleanSourceUrl(sender.url);
        const mode = message.mode === 'library' ? 'library' : 'edit';
        if (!identity || !sourceUrl) return { ok: false, error: { code: 'invalid-context' } };
        if (!trustedActions.consumeCapability(message, sender, TrustedActions.ACTIONS.PHOTO_EDITOR)) {
            return {
                ok: false,
                error: {
                    code: 'activation-required',
                    message: 'Use the report editor button to open the photo editor.',
                },
            };
        }
        const pendingId = message.localPhotoId;
        if (pendingId) {
            try { await reportPhotos.read(reportOwner(sender), pendingId); }
            catch (error) { return { ok: false, error: { message: error.message } }; }
        }
        const token = randomToken();
        const createdAt = now();
        let contextMayExist = false;
        let createdTabId = null;
        const rollbackOpen = async () => {
            const cleanup = [];
            if (contextMayExist) {
                cleanup.push({
                    owner: 'return context',
                    run: () => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
                        delete contexts[token];
                    }),
                });
            }
            if (createdTabId != null) {
                cleanup.push({
                    owner: 'tab',
                    run: () => {
                        if (typeof ext.tabs?.remove !== 'function') {
                            throw new Error('tabs.remove is unavailable');
                        }
                        return ext.tabs.remove(createdTabId);
                    },
                });
            }
            const results = await Promise.allSettled(cleanup.map(item =>
                Promise.resolve().then(item.run)));
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    try {
                        logCleanupFailure(`Better Peakbagger: photo editor ${cleanup[index].owner} cleanup failed`);
                    } catch { /* Cleanup reporting must not replace the owned public failure. */ }
                }
            });
        };
        try {
            // Treat the context as possibly written before awaiting: a storage
            // adapter can reject after an ambiguous successful commit, and the
            // rollback must still try to remove it.
            contextMayExist = true;
            await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
                contexts[token] = {
                    token,
                    sourceTabId: sender.tab.id,
                    sourceFrameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
                    sourceDocumentId: typeof sender.documentId === 'string'
                        ? sender.documentId
                        : null,
                    sourceUrl,
                    localPhotoId: pendingId || null,
                    editorTabId: null,
                    identity,
                    createdAt,
                    expiresAt: createdAt + RETURN_TTL_MS,
                    consumed: false,
                    inFlight: false,
                };
            });
            const url = new URL(photoPageBase);
            url.searchParams.set('mode', mode);
            url.searchParams.set('returnToken', token);
            if (pendingId) url.searchParams.set('localPhotoId', pendingId);
            const tab = await ext.tabs.create({ url: url.toString() });
            if (!Number.isInteger(tab?.id)) throw new Error('Photo editor tab did not open.');
            createdTabId = tab.id;
            const bound = await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
                if (!contexts[token]) return false;
                contexts[token].editorTabId = createdTabId;
                return true;
            });
            if (!bound) throw new Error('Photo editor return context disappeared.');
            return buildOpenResponse(createdTabId);
        } catch {
            await rollbackOpen();
            return {
                ok: false,
                error: { code: 'open-failed', message: 'The photo editor could not be opened.' },
            };
        }
    };

    const insertResult = async (message, sender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const token = typeof message.returnToken === 'string' ? message.returnToken : '';
        let insertion = cleanPublicInsertion(message);
        if (!token || !insertion) return { ok: false, error: { code: 'invalid-result' } };

        const context = await mutateMap(RETURN_CONTEXTS_KEY, contexts => {
            const candidate = contexts[token];
            if (!candidate || candidate.consumed || candidate.inFlight || candidate.expiresAt <= now()
                || candidate.editorTabId !== sender.tab.id) return null;
            candidate.inFlight = true;
            return { ...candidate };
        });
        if (!context) {
            return {
                ok: false,
                error: { code: 'expired-context', message: 'The original report is no longer available.' },
            };
        }
        const releaseClaim = () => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
            const candidate = contexts[token];
            if (candidate && !candidate.consumed && candidate.editorTabId === sender.tab.id) {
                candidate.inFlight = false;
            }
        });
        const consumeClaim = () => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
            const candidate = contexts[token];
            if (candidate && !candidate.consumed && candidate.editorTabId === sender.tab.id) {
                candidate.inFlight = false;
                candidate.consumed = true;
            }
        });
        if (context.localPhotoId) {
            try {
                insertion = await reportPhotos.saveEdit(reportPhotoOwner(context.sourceUrl), message, context.localPhotoId);
            } catch (error) {
                await releaseClaim();
                return { ok: false, error: { message: error.message } };
            }
        } else if (PendingPhoto.id(insertion.url)) {
            await releaseClaim();
            return { ok: false, error: { code: 'invalid-result' } };
        }
        let response;
        try {
            response = await ext.tabs.sendMessage(context.sourceTabId, {
                type: context.localPhotoId ? 'PHOTO_LOCAL_RESULT' : 'PHOTO_INSERT_RESULT',
                ...(context.localPhotoId ? { replacesLocalPhotoId: context.localPhotoId } : {}),
                returnToken: token,
                expectedIdentity: context.identity,
                expectedUrl: context.sourceUrl,
                ...insertion,
            }, {
                frameId: context.sourceFrameId,
                ...(context.sourceDocumentId
                    ? { documentId: context.sourceDocumentId }
                    : {}),
            });
        } catch {
            await releaseClaim();
            return {
                ok: false,
                error: {
                    code: 'insert-failed',
                    message: context.localPhotoId
                        ? 'The photo is saved locally, but the original report tab is no longer available.'
                        : 'The photo was uploaded, but the original report tab is no longer available.',
                },
            };
        }
        if (!response?.ok) {
            await releaseClaim();
            return {
                ok: false,
                error: {
                    code: 'insert-failed',
                    message: context.localPhotoId
                        ? 'The photo is saved locally. Keep the original image in the report, switch the report to Rich text, and choose Save and return again.'
                        : 'The photo was uploaded but could not be inserted into the report.',
                },
            };
        }
        await consumeClaim();
        return { ok: true, identity: context.identity };
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

    const forgetSourceTab = tabId => mutateMap(RETURN_CONTEXTS_KEY, contexts => {
        Object.entries(contexts).forEach(([token, context]) => {
            if (context?.sourceTabId === tabId) delete contexts[token];
        });
    });

    return {
        handlers: {
            PHOTO_REPORT_STATUS: reportStatus,
            PHOTO_REPORT_CREATE: createReportPhoto,
            PHOTO_REPORT_READ: readReportPhoto,
            PHOTO_REPORT_UPLOAD: uploadReportPhoto,
            PHOTO_IMGBB_STATUS: status,
            PHOTO_IMGBB_SAVE_KEY: saveKey,
            PHOTO_IMGBB_REMOVE_KEY: removeKey,
            PHOTO_IMGBB_LEASE_KEY: leaseKey,
            PHOTO_EDITOR_OPEN: openEditor,
            PHOTO_INSERT_COMMIT: insertResult,
        },
        cleanup,
        forgetTab,
        forgetSourceTab,
        isPhotoPage,
    };
}

export const photoRoutes = {
    RETURN_CONTEXTS_KEY,
    RETURN_TTL_MS,
    IMGBB_PERMISSION,
    cleanDraftIdentity,
    cleanSourceUrl,
    cleanPublicInsertion,
};
