// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — trusted photo-page credential and report-return routes.

import { imgbbAuth as ImgbbAuth } from '../photos/imgbb-auth.js';
import { photoLibrary as Library } from '../photos/photo-library.js';
import { sanitizeReportDimension } from '../reports/report-markup.js';
import { createPackagedPageMatcher } from './sender-policy.js';
import { createReportPhotoService, reportPhotoOwner } from './report-photo-service.js';
import { reportPhoto as PendingPhoto } from '../photos/report-photo.js';
import { trustedActions as TrustedActions } from './trusted-actions.js';

const RETURN_CONTEXTS_KEY = 'bpbPhotoEditorReturns';
const RETURN_TTL_MS = 2 * 60 * 60 * 1000;
const IMGBB_PERMISSION = Object.freeze({ origins: ['https://api.imgbb.com/*'] });

// Runtime messages cross a trust boundary: every field stays `unknown` until a
// cleaner or gate below has checked it.
type PhotoMessage = Record<string, unknown> & { type?: string };
type ReportOwner = NonNullable<ReturnType<typeof reportPhotoOwner>>;
type ReportOperation = (message: PhotoMessage, sender: chrome.runtime.MessageSender, owner: ReportOwner) => unknown;
interface ReturnContext { token: string; sourceTabId: number; sourceFrameId: number; sourceDocumentId: string | null; sourceUrl: string; localPhotoId: string | null; imageEditId?: string; editorTabId: number | null; identity: object; createdAt: number; expiresAt: number; consumed: boolean; inFlight: boolean; [field: string]: unknown }
type ReturnContexts = Record<string, ReturnContext>;
interface PhotoRouteOptions {
    ext: typeof chrome; storage: chrome.storage.StorageArea; isPeakbaggerSender: (sender: chrome.runtime.MessageSender) => boolean;
    mutateMap: <T>(key: string, mutate: (contexts: ReturnContexts) => T) => Promise<T>; readMap: (key: string) => Promise<ReturnContexts>;
    now?: () => number; randomToken?: () => string; keyStore?: typeof ImgbbAuth.keyStore;
    trustedActions: { consumeCapability(message: object, sender: chrome.runtime.MessageSender, action: string): boolean; consumeGrant(message: object, sender: chrome.runtime.MessageSender, action: string): boolean | Promise<boolean> };
    buildOpenResponse?: (tabId: number) => object; logCleanupFailure?: (message: string) => void; onPhotoLibraryChanged?: () => Promise<unknown>;
}

const cleanIdentityNumber = (value: unknown, { signed = false } = {}) => {
    if (value == null) return null;
    const number = typeof value === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(value)
        ? Number(value)
        : value as number;
    return Number.isSafeInteger(number) && (signed || number > 0) ? number : null;
};

const cleanDraftIdentity = (value: Record<string, unknown>) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cid = cleanIdentityNumber(value.cid);
    const aid = cleanIdentityNumber(value.aid);
    const pid = cleanIdentityNumber(value.pid, { signed: true });
    if (value.cid != null && cid == null) return null;
    if (value.aid != null && aid == null) return null;
    if (value.pid != null && pid == null) return null;
    return { cid, aid, pid };
};

const cleanSourceUrl = (value: string) => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        url.hash = '';
        return url.toString();
    } catch { return null; }
};

const cleanPublicInsertion = (value: PhotoMessage) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const localPhotoId = typeof value.localPhotoId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.localPhotoId)
        ? value.localPhotoId
        : null;
    const alt = String(value.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, Library.ALT_LIMIT);
    let url;
    try {
        const parsed = new URL(value.url as string);
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
        ...(typeof value.caption === 'string' ? { caption: value.caption.replace(/\s+/g, ' ').trim().slice(0, Library.ALT_LIMIT) } : {}),
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
    buildOpenResponse = (tabId: number) => ({ ok: true, tabId }),
    logCleanupFailure = (message: string) => console.error(message),
    onPhotoLibraryChanged = async () => {},
}: PhotoRouteOptions = {} as PhotoRouteOptions) {
    if (!ext || !storage || !isPeakbaggerSender || !mutateMap || !readMap || !keyStore
        || !trustedActions
        || typeof buildOpenResponse !== 'function' || typeof logCleanupFailure !== 'function') {
        throw new TypeError('photo routes require extension, storage, and sender dependencies');
    }

    // The shared worker must still boot when an embedded/test environment does
    // not expose extension-page URLs. Photo routes remain unavailable and fail
    // closed in that environment.
    const packagedPage = (page: string) => {
        const base = typeof ext.runtime?.getURL === 'function' ? ext.runtime.getURL(page) : null;
        return (sender: chrome.runtime.MessageSender) => {
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
    const isCredentialPage = (sender: chrome.runtime.MessageSender) => isPhotoPage(sender) || isOptionsPage(sender);

    const permissionGranted = async () => !!(ext.permissions?.contains
        && await ext.permissions.contains(IMGBB_PERMISSION));

    const reportPhotos = createReportPhotoService({ keyStore, permissionGranted, onChanged: onPhotoLibraryChanged } as never);
    const reportOwner = (sender: chrome.runtime.MessageSender) => isPeakbaggerSender(sender) && Number.isInteger(sender.tab?.id)
        ? reportPhotoOwner(sender.url) : null;
    const reportRoute = (operation: ReportOperation) => async (message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        const owner = reportOwner(sender);
        if (!owner) return { ok: false, error: { code: 'forbidden' } };
        try { return { ok: true, ...await operation(message, sender, owner) as object }; }
        catch (error) { return { ok: false, error: { message: (error as Error).message } }; }
    };
    const reportStatus = reportRoute(async () => ({
        configured: !!await keyStore.read(), permissionGranted: await permissionGranted(),
    }));
    const createReportPhoto = reportRoute(async (message: PhotoMessage, sender: chrome.runtime.MessageSender, owner: ReportOwner) => {
        if (!trustedActions.consumeCapability(message, sender, TrustedActions.ACTIONS.REPORT_PHOTOS)) {
            throw new Error('Paste a photo into the report to add it.');
        }
        if (!await keyStore.read() || !await permissionGranted()) {
            throw new Error('Set up ImgBB in Settings before pasting photos.');
        }
        return reportPhotos.create(owner, message);
    });
    const readReportPhoto = reportRoute(async (message: PhotoMessage, sender: chrome.runtime.MessageSender, owner: ReportOwner) => {
        const { image } = await reportPhotos.read(owner, message.localPhotoId);
        return { dataUrl: image.dataUrl };
    });
    const uploadReportPhoto = reportRoute(async (message: PhotoMessage, sender: chrome.runtime.MessageSender, owner: ReportOwner) => {
        if (!await trustedActions.consumeGrant(message, sender, TrustedActions.ACTIONS.REPORT_PHOTOS)) {
            throw new Error('Use Save Ascent to upload report photos.');
        }
        return reportPhotos.uploadOne(owner, message.localPhotoId);
    });
    const confirmReportPhoto = reportRoute((message: PhotoMessage, sender: chrome.runtime.MessageSender, owner: ReportOwner) => reportPhotos.confirmInsertion(owner, message as never));

    const status = async (_message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isCredentialPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const stored = await keyStore.read();
        return {
            ok: true,
            configured: !!stored,
            savedAt: stored?.savedAt || null,
            permissionGranted: await permissionGranted(),
        };
    };

    const saveKey = async (message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
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

    const removeKey = async (_message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isCredentialPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        await keyStore.clear();
        return { ok: true };
    };

    const leaseKey = async (_message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const key = await keyStore.getKey();
        return key
            ? { ok: true, key }
            : { ok: false, error: { code: 'not-configured', message: 'Enter an ImgBB API key.' } };
    };

    // A tab carrying report context belongs to that report's Save-and-return, so
    // the toolbar never takes it over: it reuses only an unbound photo tab,
    // preferring one that opened on the editor over one that opened on the library.
    const isPopup = createPackagedPageMatcher(ext, ['popup/popup.html']);
    const standaloneView = (url: string | undefined) => {
        try {
            const actual = new URL(url || ''), expected = new URL(photoPageBase!);
            if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname
                || ['returnToken', 'localPhotoId', 'imageUrl'].some(name => actual.searchParams.has(name))) return null;
            return actual.searchParams.get('mode') === 'library' ? 'library' : 'editor';
        } catch { return null; }
    };
    let openingStandalone: Promise<{ ok: boolean; tabId?: number }> | null = null;
    const openStandaloneEditor = (_message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPopup(sender)) return { ok: false, error: { code: 'forbidden' } };
        openingStandalone ||= (async () => {
            try {
                const tabs = await ext.tabs.query({});
                const tab = tabs.find(candidate => standaloneView(candidate.url) === 'editor')
                    || tabs.find(candidate => standaloneView(candidate.url) === 'library');
                if (!tab) {
                    const created = await ext.tabs.create({ url: photoPageBase!, active: true });
                    return { ok: true, tabId: created.id };
                }
                await ext.tabs.update(tab.id!, { active: true });
                if (Number.isInteger(tab.windowId)) await ext.windows.update(tab.windowId, { focused: true });
                return { ok: true, tabId: tab.id };
            } catch { return { ok: false }; }
        })().finally(() => { openingStandalone = null; });
        return openingStandalone;
    };

    const openEditor = async (message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPeakbaggerSender(sender) || !Number.isInteger(sender.tab?.id)) {
            return {
                ok: false,
                error: { code: 'forbidden', message: 'Open the photo editor from a Peakbagger report.' },
            };
        }
        const identity = cleanDraftIdentity((message.identity || {}) as Record<string, unknown>);
        const sourceUrl = cleanSourceUrl(sender.url!);
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
        const imageEditId = typeof message.imageEditId === 'string'
            && /^[A-Za-z0-9:_-]{1,100}$/.test(message.imageEditId) ? message.imageEditId : null;
        const imageUrl = typeof message.imageUrl === 'string' && message.imageUrl.length <= Library.URL_LIMIT
            ? cleanSourceUrl(message.imageUrl) : null;
        if ((message.imageEditId && !imageEditId) || (message.imageUrl && (!imageUrl || !imageEditId || pendingId))) {
            return { ok: false, error: { code: 'invalid-image' } };
        }
        if (pendingId) {
            try { await reportPhotos.read(reportOwner(sender), pendingId); }
            catch (error) { return { ok: false, error: { message: (error as Error).message } }; }
        }
        const token = randomToken();
        const createdAt = now();
        let contextMayExist = false;
        let createdTabId: number | null = null;
        const rollbackOpen = async () => {
            const cleanup: { owner: string; run: () => unknown }[] = [];
            if (contextMayExist) {
                cleanup.push({
                    owner: 'return context',
                    run: () => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
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
                        return ext.tabs.remove(createdTabId!);
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
            await mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
                contexts[token] = {
                    token,
                    sourceTabId: sender.tab!.id!,
                    sourceFrameId: Number.isInteger(sender.frameId) ? sender.frameId! : 0,
                    sourceDocumentId: typeof sender.documentId === 'string'
                        ? sender.documentId
                        : null,
                    sourceUrl,
                    localPhotoId: (pendingId as string) || null,
                    ...(imageEditId ? { imageEditId } : {}),
                    editorTabId: null,
                    identity,
                    createdAt,
                    expiresAt: createdAt + RETURN_TTL_MS,
                    consumed: false,
                    inFlight: false,
                };
            });
            const url = new URL(photoPageBase!);
            url.searchParams.set('mode', mode);
            url.searchParams.set('returnToken', token);
            if (pendingId) url.searchParams.set('localPhotoId', pendingId as string);
            if (imageUrl) url.searchParams.set('imageUrl', imageUrl);
            if (imageUrl) url.searchParams.set('imageAlt', String(message.imageAlt || '').slice(0, Library.ALT_LIMIT));
            if (imageEditId && typeof message.imageCaption === 'string') {
                url.searchParams.set('imageCaption', message.imageCaption.slice(0, Library.ALT_LIMIT));
            }
            const tab = await ext.tabs.create({ url: url.toString() });
            if (!Number.isInteger(tab?.id)) throw new Error('Photo editor tab did not open.');
            createdTabId = tab.id!;
            const bound = await mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
                if (!contexts[token]) return false;
                contexts[token].editorTabId = createdTabId;
                return true;
            });
            if (!bound) throw new Error('Photo editor return context disappeared.');
            return buildOpenResponse(createdTabId!);
        } catch {
            await rollbackOpen();
            return {
                ok: false,
                error: { code: 'open-failed', message: 'The photo editor could not be opened.' },
            };
        }
    };

    const insertResult = async (message: PhotoMessage, sender: chrome.runtime.MessageSender) => {
        if (!isPhotoPage(sender)) return { ok: false, error: { code: 'forbidden' } };
        const token = typeof message.returnToken === 'string' ? message.returnToken : '';
        let insertion = cleanPublicInsertion(message);
        if (!token || !insertion) return { ok: false, error: { code: 'invalid-result' } };

        const context = await mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
            const candidate = contexts[token];
            if (!candidate || candidate.consumed || candidate.inFlight || candidate.expiresAt <= now()
                || candidate.editorTabId !== sender.tab!.id) return null;
            candidate.inFlight = true;
            return { ...candidate };
        });
        if (!context) {
            return {
                ok: false,
                error: { code: 'expired-context', message: 'The original report is no longer available.' },
            };
        }
        const releaseClaim = () => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
            const candidate = contexts[token];
            if (candidate && !candidate.consumed && candidate.editorTabId === sender.tab!.id) {
                candidate.inFlight = false;
            }
        });
        const consumeClaim = () => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
            const candidate = contexts[token];
            if (candidate && !candidate.consumed && candidate.editorTabId === sender.tab!.id) {
                candidate.inFlight = false;
                candidate.consumed = true;
            }
        });
        if (context.localPhotoId) {
            try {
                insertion = await reportPhotos.saveEdit(reportPhotoOwner(context.sourceUrl), message, context.localPhotoId);
            } catch (error) {
                await releaseClaim();
                return { ok: false, error: { message: (error as Error).message } };
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
                ...(context.imageEditId ? { imageEditId: context.imageEditId } : {}),
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

    const cleanup = (cutoff: number) => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
        Object.entries(contexts).forEach(([token, context]) => {
            if (!context || context.expiresAt <= cutoff || context.consumed) delete contexts[token];
        });
    });

    const forgetTab = (tabId: number) => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
        Object.entries(contexts).forEach(([token, context]) => {
            if (context?.sourceTabId === tabId || context?.editorTabId === tabId) delete contexts[token];
        });
    });

    const forgetSourceTab = (tabId: number) => mutateMap(RETURN_CONTEXTS_KEY, (contexts: ReturnContexts) => {
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
            PHOTO_REPORT_INSERTED: confirmReportPhoto,
            PHOTO_IMGBB_STATUS: status,
            PHOTO_IMGBB_SAVE_KEY: saveKey,
            PHOTO_IMGBB_REMOVE_KEY: removeKey,
            PHOTO_IMGBB_LEASE_KEY: leaseKey,
            PHOTO_EDITOR_OPEN: openEditor,
            PHOTO_STANDALONE_OPEN: openStandaloneEditor,
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
};
