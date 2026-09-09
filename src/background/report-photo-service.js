// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { photoStore as Store } from '../photos/photo-store.js';
import { photoLibrary as Library } from '../photos/photo-library.js';
import { photoProject as Project } from '../photos/photo-project.js';
import { reportPhoto as Pending } from '../photos/report-photo.js';
import { imgbbClient as Client } from '../photos/imgbb-client.js';
import { reportDrafts as Drafts } from '../reports/report-drafts.js';

export const reportPhotoOwner = source => {
    try {
        const url = new URL(source);
        if (!/^\/climber\/ascentedit\.aspx$/i.test(url.pathname)) return null;
        const identity = Object.fromEntries(['cid', 'aid', 'pid'].map(key => [key, url.searchParams.get(key)]));
        const key = Drafts.keyFor(identity);
        return Drafts.parseKey(key) ? key : null;
    } catch { return null; }
};

export function createReportPhotoService({
    openStore = () => Store.createPhotoStore(), upload = options => Client.upload(options),
    keyStore, permissionGranted,
} = {}) {
    const locks = new Map();
    const useStore = async operation => {
        const store = await openStore();
        try { return await operation(store); } finally { store.close(); }
    };
    const metadata = async (dataUrl, dimensions) => {
        const blob = Pending.fromDataUrl(dataUrl);
        const image = Project.cleanImageDimensions(dimensions);
        if (!image) throw new Error('The photo dimensions are unsupported.');
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return { blob, exported: {
            ...image, mime: blob.type, bytes: blob.size,
            sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        } };
    };
    const read = (owner, localId) => useStore(async store => {
        if (!owner || !Pending.url(localId)) throw new Error('The photo does not belong to this report.');
        const image = await store.getReportImage(localId);
        const { photo, project } = await store.getBundle(localId);
        if (!image || image.owner !== owner || !photo || photo.deletedAt) {
            throw new Error('The local photo is unavailable. Remove it or restore it from the photo library.');
        }
        return { image, photo, project };
    });
    const create = (owner, message) => useStore(async store => {
        const { blob, exported } = await metadata(message.dataUrl, message);
        const localId = message.localPhotoId || crypto.randomUUID();
        if (!Pending.url(localId)) throw new Error('The local photo reference is invalid.');
        const project = Project.cleanProject({
            ...Project.createProject({ localId, ...exported, sourceSha256: exported.sha256 }),
            export: { mime: exported.mime, quality: exported.mime === 'image/png' ? 1 : Project.DEFAULT_JPEG_QUALITY },
        });
        const draft = Library.createDraft({
            localId, title: 'Pasted photo', source: { ...exported, fileName: 'pasted-photo.png' },
        });
        const photo = await store.putDraft({ photo: draft, project, original: blob,
            thumbnail: Pending.fromDataUrl(message.thumbnail) });
        await store.putReportImage({ localId, owner, dataUrl: message.dataUrl, exported, revision: photo.revision });
        return { localPhotoId: localId, url: Pending.url(localId), alt: photo.alt };
    });
    const saveEdit = (owner, message, replacesLocalPhotoId) => useStore(async store => {
        const { photo } = await store.getBundle(message.localPhotoId);
        if (!owner || !photo || photo.deletedAt || photo.remote.state !== 'draft'
            || photo.lineage.parentLocalId !== replacesLocalPhotoId) {
            throw new Error('Save an editable local photo first.');
        }
        const { exported } = await metadata(message.dataUrl, photo.source);
        await store.putReportImage({ localId: photo.localId, owner, dataUrl: message.dataUrl,
            exported, revision: photo.revision });
        return { localPhotoId: photo.localId, url: Pending.url(photo.localId), alt: photo.alt };
    });
    const uploadOne = async (owner, localId) => {
        if (locks.has(localId)) throw new Error('This photo is already being uploaded. Wait for that save to finish.');
        const work = useStore(async store => {
            const { image, photo: initialPhoto, project } = await read(owner, localId);
            let photo = initialPhoto;
            const operations = await store.getOperations();
            let operation = operations.find(item => item.localId === localId);
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
            if (image.content !== JSON.stringify({ project: { ...project, updatedAt: null }, title: photo.title, alt: photo.alt })) {
                throw new Error('This photo changed in the photo editor. Save it back to the report before saving the TR.');
            }
            if (!await permissionGranted()) throw new Error('Allow ImgBB access in Settings, then save the TR again.');
            const key = await keyStore.getKey();
            if (!key) throw new Error('Set up your ImgBB key in Settings, then save the TR again.');
            const blob = Pending.fromDataUrl(image.dataUrl);
            const started = await store.beginUploadOperation({
                photo: Library.beginUpload(photo, image.exported),
                operation: { operationId: crypto.randomUUID(), localId, state: 'request-started',
                    export: image.exported, returnToken: null, updatedAt: new Date().toISOString() },
            });
            photo = started.photo;
            operation = started.operation;
            let response = null;
            try {
                response = await upload({ fetch: globalThis.fetch.bind(globalThis), key, blob, name: photo.title });
                operation = { ...operation, state: 'response-received', remote: response.remote,
                    deleteUrl: response.deleteUrl, updatedAt: new Date().toISOString() };
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
            return { url: photo.remote.url, alt: photo.alt };
        });
        locks.set(localId, work);
        try { return await work; } finally { locks.delete(localId); }
    };
    return { create, read, saveEdit, uploadOne };
}
