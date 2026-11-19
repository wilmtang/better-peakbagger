// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoStore as Store } from '../photos/photo-store.ts';
import { photoLibrary as Library } from '../photos/photo-library.ts';
import { photoProject as Project } from '../photos/photo-project.ts';
import { reportPhoto as Pending } from '../photos/report-photo.ts';
import { imgbbClient as Client } from '../photos/imgbb-client.ts';
import { reportDrafts as Drafts } from '../reports/report-drafts.ts';

export type ReportPhotoStore = Awaited<ReturnType<typeof Store.createPhotoStore>>;

export interface ReportPhotoUploadInput {
    fetch: typeof globalThis.fetch;
    key: string;
    blob: Blob;
    name: string;
}

export interface ReportPhotoUploadResponse {
    remote: unknown;
    deleteUrl: string;
}

export interface ReportPhotoKeyStore {
    getKey(): Promise<string | null>;
}

export interface CreateReportPhotoServiceOptions {
    openStore?: () => Promise<ReportPhotoStore>;
    upload?: (options: ReportPhotoUploadInput) => Promise<ReportPhotoUploadResponse>;
    keyStore?: ReportPhotoKeyStore;
    permissionGranted?: () => Promise<boolean>;
    onChanged?: () => Promise<unknown>;
}

export type ReportPhotoMessage = Record<string, unknown>;

export const reportPhotoOwner = (source: unknown): string | null => {
    try {
        const url = new URL(source as string);
        if (!/^\/climber\/ascentedit\.aspx$/i.test(url.pathname)) return null;
        if (['cid', 'aid', 'pid'].some(key => url.searchParams.getAll(key).length > 1)) return null;
        const identity = Object.fromEntries(['cid', 'aid', 'pid'].map(key => [key, url.searchParams.get(key)]));
        if (identity.aid && identity.pid) return null;
        const key = Drafts.keyFor(identity);
        return Drafts.parseKey(key) ? key : null;
    } catch { return null; }
};

export function createReportPhotoService({
    openStore = () => Store.createPhotoStore(),
    upload = options => Client.upload(options),
    keyStore,
    permissionGranted,
    onChanged = async () => {},
}: CreateReportPhotoServiceOptions = {}) {
    const locks = new Map<string, Promise<{ url: string; alt: string }>>();
    const announceChange = async () => {
        // The durable watchdog recovers a failed nudge. Scheduling cannot turn
        // a committed local save or confirmed upload into a report-save error.
        try { await onChanged(); } catch {}
    };
    const useStore = async <T>(operation: (store: ReportPhotoStore) => Promise<T>): Promise<T> => {
        const store = await openStore();
        try { return await operation(store); } finally { store.close(); }
    };
    const metadata = async (dataUrl: unknown, dimensions: unknown) => {
        const blob = Pending.fromDataUrl(dataUrl);
        const image = Project.cleanImageDimensions(dimensions);
        if (!image) throw new Error('The photo dimensions are unsupported.');
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return {
            blob,
            exported: {
                ...image,
                mime: blob.type,
                bytes: blob.size,
                sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
            },
        };
    };
    const read = (owner: string | null | undefined, localId: unknown) => useStore(async store => {
        if (!owner || typeof localId !== 'string' || !Pending.url(localId)) {
            throw new Error('The photo does not belong to this report.');
        }
        const image = await store.getReportImage(localId);
        const { photo, project } = await store.getBundle(localId);
        if (!image || image.owner !== owner || !photo || photo.deletedAt) {
            throw new Error('The local photo is unavailable. Remove it or restore it from the photo library.');
        }
        return { image, photo, project };
    });
    const create = (owner: string, message: ReportPhotoMessage) => useStore(async store => {
        const { blob, exported } = await metadata(message.dataUrl, message);
        const rawLocalId = message.localPhotoId || crypto.randomUUID();
        if (typeof rawLocalId !== 'string' || !Pending.url(rawLocalId)) {
            throw new Error('The local photo reference is invalid.');
        }
        const localId = rawLocalId;
        const project = Project.cleanProject({
            ...Project.createProject({ localId, ...exported, sourceSha256: exported.sha256 }),
            export: { mime: exported.mime, quality: exported.mime === 'image/png' ? 1 : Project.DEFAULT_JPEG_QUALITY },
        });
        const draft = Library.createDraft({
            localId,
            title: 'Pasted photo',
            source: { ...exported, fileName: 'pasted-photo.png' },
        });
        const photo = await store.putDraft({
            photo: draft,
            project,
            original: blob,
            thumbnail: Pending.fromDataUrl(message.thumbnail),
        });
        await store.putReportImage({
            localId,
            owner,
            dataUrl: message.dataUrl as string,
            exported,
            revision: photo.revision,
        });
        await announceChange();
        return { localPhotoId: localId, url: Pending.url(localId)!, alt: photo.alt };
    });
    const saveEdit = (
        owner: string | null | undefined,
        message: ReportPhotoMessage,
        replacesLocalPhotoId: string | null | undefined,
    ) => useStore(async store => {
        const localPhotoId = typeof message.localPhotoId === 'string' ? message.localPhotoId : '';
        const { photo } = await store.getBundle(localPhotoId);
        if (!owner || !photo || photo.deletedAt || photo.remote.state !== 'draft'
            || (photo.localId !== replacesLocalPhotoId && photo.lineage.parentLocalId !== replacesLocalPhotoId)) {
            throw new Error('Save an editable local photo first.');
        }
        // A child version's lineage is not authority over its parent's report.
        // Verify the accepted parent still exists and belongs to this owner.
        await read(owner, replacesLocalPhotoId);
        const { exported } = await metadata(message.dataUrl, photo.source);
        await store.putReportImage({
            localId: photo.localId,
            owner,
            dataUrl: message.dataUrl as string,
            exported,
            revision: photo.revision,
            replacesLocalPhotoId: typeof replacesLocalPhotoId === 'string' ? replacesLocalPhotoId : null,
        });
        await announceChange();
        return {
            localPhotoId: photo.localId,
            url: Pending.url(photo.localId)!,
            alt: photo.alt,
            caption: photo.caption || '',
        };
    });
    const uploadOne = async (owner: string, localId: unknown): Promise<{ url: string; alt: string }> => {
        const id = typeof localId === 'string' ? localId : '';
        if (id && locks.has(id)) throw new Error('This photo is already being uploaded. Wait for that save to finish.');
        const work = useStore(async store => {
            const { image, photo: initialPhoto, project } = await read(owner, localId);
            let photo = initialPhoto;
            const operations = await store.getOperations();
            let operation = operations.find(item => item.localId === id);
            // A received response is durable evidence: finish cataloging it,
            // never send the pixels again after worker or report interruption.
            if (operation?.state === 'response-received') {
                ({ photo, operation } = await store.commitUploadOperation({
                    photo: Library.completeUpload(photo, operation.export, operation.remote),
                    operationId: operation.operationId,
                }));
            }
            if (photo.remote.state === 'uploaded') return { url: photo.remote.url, alt: photo.alt };
            if (photo.remote.state !== 'draft' || operation) {
                throw new Error('An earlier upload may have reached ImgBB. Check the photo library and ImgBB before uploading again.');
            }
            const projectSnapshot = project ? { ...project, updatedAt: null } : { updatedAt: null };
            if (image.content !== JSON.stringify({
                project: projectSnapshot,
                title: photo.title,
                alt: photo.alt,
                ...(photo.caption ? { caption: photo.caption } : {}),
            })) {
                throw new Error('This photo changed in the photo editor. Save it back to the report before saving the TR.');
            }
            if (!permissionGranted || !await permissionGranted()) {
                throw new Error('Allow ImgBB access in Settings, then save the TR again.');
            }
            const key = keyStore ? await keyStore.getKey() : null;
            if (!key) throw new Error('Set up your ImgBB key in Settings, then save the TR again.');
            const blob = Pending.fromDataUrl(image.dataUrl);
            const started = await store.beginUploadOperation({
                photo: Library.beginUpload(photo, image.exported),
                operation: {
                    operationId: crypto.randomUUID(),
                    localId: id,
                    state: 'request-started',
                    export: image.exported,
                    returnToken: null,
                    updatedAt: new Date().toISOString(),
                },
            });
            photo = started.photo;
            operation = started.operation;
            let response: ReportPhotoUploadResponse | null = null;
            try {
                response = await upload({ fetch: globalThis.fetch.bind(globalThis), key, blob, name: photo.title });
                operation = {
                    ...operation,
                    state: 'response-received',
                    remote: response.remote,
                    deleteUrl: response.deleteUrl,
                    updatedAt: new Date().toISOString(),
                };
                await store.putOperation(operation);
                ({ photo } = await store.commitUploadOperation({
                    photo: Library.completeUpload(photo, image.exported, response.remote),
                    operationId: operation.operationId,
                }));
            } catch (error) {
                const failure = Client.publicError(error);
                if (!response && !failure.ambiguous) {
                    await store.resetUploadOperation({ photo: Library.resetUpload(photo), operationId: operation.operationId });
                }
                // Retain request-started/response-received on uncertain outcomes.
                // Recovery owns them, even if writing the status also fails.
                throw new Error(response
                    ? 'ImgBB accepted the photo, but local confirmation failed. Save the TR again to check the saved upload.'
                    : failure.message);
            }
            await store.deleteOperation(operation.operationId).catch(() => {});
            if (photo.remote.state !== 'uploaded' && photo.remote.state !== 'unreachable') {
                throw new Error('ImgBB accepted the photo, but local confirmation failed. Save the TR again to check the saved upload.');
            }
            return { url: photo.remote.url, alt: photo.alt };
        });
        if (id) locks.set(id, work);
        try { return await work; } finally { if (id) locks.delete(id); await announceChange(); }
    };
    const confirmInsertion = (
        owner: string,
        { localPhotoId, url }: { localPhotoId?: unknown; url?: unknown },
    ) => useStore(async store => {
        const identity = Drafts.parseKey(owner);
        if (!identity) throw new Error('The photo does not belong to this report.');
        const reference = {
            kind: 'ascent-draft' as const,
            cid: Number(identity.cid) || null,
            aid: identity.kind === 'ascent' ? Number(identity.id) : null,
            pid: identity.kind === 'peak' ? Number(identity.id) : null,
        };
        for (let attempt = 0; attempt < 3; attempt++) {
            const { photo } = await read(owner, localPhotoId);
            if (photo.remote.state !== 'uploaded' || photo.remote.url !== url) {
                throw new Error('The inserted image does not match this report photo.');
            }
            if (photo.references.some(existing =>
                (['kind', 'cid', 'aid', 'pid'] as const).every(key => existing[key] === reference[key]))) {
                return { recorded: true };
            }
            try {
                const now = new Date().toISOString();
                await store.putPhoto(Library.addReference(photo, { ...reference, insertedAt: now }, now));
                await announceChange();
                return { recorded: true };
            } catch (error) {
                if (error instanceof Error && error.name === 'PhotoStoreConflictError' && attempt < 2) continue;
                throw new Error('The photo is inserted, but its library reference could not be recorded. Save Ascent again to retry.');
            }
        }
        throw new Error('The photo is inserted, but its library reference could not be recorded. Save Ascent again to retry.');
    });
    return { create, read, saveEdit, uploadOne, confirmInsertion };
}
