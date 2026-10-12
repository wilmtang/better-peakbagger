// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { photoStore as Store } from '../../src/photos/photo-store.js';
import { imgbbClient as Client } from '../../src/photos/imgbb-client.js';
import { photoLibrary as Library } from '../../src/photos/photo-library.js';
import { createReportPhotoService, reportPhotoOwner } from '../../src/background/report-photo-service.js';

const image = { width: 2, height: 1, dataUrl: 'data:image/png;base64,aW1hZ2U=', thumbnail: 'data:image/png;base64,dGh1bWI=' };
const remote = { providerId: 'abc', displayUrl: 'https://i.ibb.co/abc/photo.png', thumbnailUrl: 'https://i.ibb.co/abc/thumb.png', url: 'https://i.ibb.co/abc/photo.png', viewerUrl: 'https://ibb.co/abc',
    thumbUrl: null, mediumUrl: null, uploadedAt: '2026-09-08T12:00:00.000Z', expiresAt: null };
const owner = 'bpbReportDraft:1:p2';
const harness = async (upload, onChanged = async () => {}) => {
    const indexedDB = new IDBFactory();
    const openStore = () => Store.createPhotoStore({ indexedDB });
    const store = await openStore();
    const service = createReportPhotoService({ openStore, upload, onChanged,
        permissionGranted: async () => true, keyStore: { getKey: async () => 'private-key' } });
    return { service, store };
};

test('report photo saves and uploads nudge automatic catalog backup without depending on its success', async () => {
    let changes = 0;
    const { service, store } = await harness(async () => ({ remote, deleteUrl: 'https://ibb.co/abc/delete' }),
        async () => { changes++; throw new Error('alarm unavailable'); });
    const created = await service.create(owner, image);
    assert.equal(changes, 1);
    await service.saveEdit(owner, { localPhotoId: created.localPhotoId, dataUrl: image.dataUrl }, created.localPhotoId);
    assert.equal(changes, 2);
    assert.equal((await service.uploadOne(owner, created.localPhotoId)).url, remote.url);
    assert.equal(changes, 3);
    store.close();
});

test('pasted pixels remain local, report ownership is enforced, confirmed uploads are reused', async () => {
    let uploads = 0;
    const { service, store } = await harness(async ({ key, blob }) => {
        uploads++;
        assert.equal(key, 'private-key');
        assert.equal(await blob.text(), 'image');
        return { remote, deleteUrl: 'https://ibb.co/abc/delete' };
    });
    const created = await service.create(owner, image);
    assert.equal(uploads, 0);
    assert.equal((await service.read(owner, created.localPhotoId)).image.dataUrl, image.dataUrl);
    await assert.rejects(service.read('bpbReportDraft:2:p2', created.localPhotoId), /unavailable/);
    await assert.rejects(service.uploadOne('bpbReportDraft:2:p2', created.localPhotoId), /unavailable/);
    assert.equal(uploads, 0);
    assert.equal((await service.uploadOne(owner, created.localPhotoId)).url, remote.url);
    assert.equal((await service.uploadOne(owner, created.localPhotoId)).url, remote.url);
    assert.equal(uploads, 1);
    assert.equal((await store.getBundle(created.localPhotoId)).deleteUrl, 'https://ibb.co/abc/delete');
    await store.removeLocalAssets(created.localPhotoId, new Date().toISOString());
    assert.equal(await store.getReportImage(created.localPhotoId), null);
    store.close();
});

test('an uncertain upload cannot be repeated after a new service lifetime', async () => {
    let uploads = 0;
    const { service, store } = await harness(async () => {
        uploads++;
        throw new Client.ImgbbError('network', 'Connection lost', { ambiguous: true });
    });
    const created = await service.create(owner, image);
    await assert.rejects(service.uploadOne(owner, created.localPhotoId), /Connection lost/);
    await assert.rejects(service.uploadOne(owner, created.localPhotoId), /earlier upload may have reached/);
    assert.equal(uploads, 1);
    assert.equal((await store.getOperations())[0].state, 'request-started');
    store.close();
});

test('a definite provider refusal preserves a draft that can be corrected and retried', async () => {
    let uploads = 0;
    const { service, store } = await harness(async () => {
        uploads++;
        if (uploads === 1) throw new Client.ImgbbError('rejected', 'Invalid key', { ambiguous: false });
        return { remote, deleteUrl: 'https://ibb.co/abc/delete' };
    });
    const created = await service.create(owner, image);
    await assert.rejects(service.uploadOne(owner, created.localPhotoId), /Invalid key/);
    assert.equal((await store.getBundle(created.localPhotoId)).photo.remote.state, 'draft');
    assert.equal((await store.getOperations()).length, 0);
    assert.equal((await service.uploadOne(owner, created.localPhotoId)).url, remote.url);
    assert.equal(uploads, 2);
    store.close();
});

test('a durable ImgBB response is committed after interruption without another upload', async () => {
    const { service, store } = await harness(async () => { throw new Error('must not upload'); });
    const created = await service.create(owner, image);
    const { photo, image: snapshot } = await service.read(owner, created.localPhotoId);
    const started = await store.beginUploadOperation({ photo: Library.beginUpload(photo, snapshot.exported),
        operation: { localId: photo.localId, operationId: 'interrupted', state: 'request-started', export: snapshot.exported } });
    await store.putOperation({ ...started.operation, state: 'response-received', remote, deleteUrl: 'https://ibb.co/abc/delete' });
    assert.equal((await service.uploadOne(owner, created.localPhotoId)).url, remote.url);
    assert.equal((await store.getBundle(photo.localId)).photo.remote.state, 'uploaded');
    store.close();
});

test('saving an edited copy is local and cannot change the accepted image before return', async () => {
    let uploads = 0;
    const { service, store } = await harness(async () => { uploads++; });
    const original = await service.create(owner, image);
    const bundle = await store.getBundle(original.localPhotoId);
    const localId = crypto.randomUUID();
    await store.putDraft({ ...bundle,
        photo: Library.createDraft({ localId, title: 'Edited', source: bundle.photo.source, parentLocalId: bundle.photo.localId }),
        project: { ...bundle.project, localId } });
    const edit = { localPhotoId: localId, dataUrl: 'data:image/png;base64,ZWRpdA==' };
    await assert.rejects(service.saveEdit(owner, edit, 'wrong-parent'), /editable local photo/);
    const result = await service.saveEdit(owner, edit, original.localPhotoId);
    assert.equal((await service.read(owner, result.localPhotoId)).image.dataUrl, edit.dataUrl);
    assert.equal((await service.read(owner, original.localPhotoId)).image.dataUrl, image.dataUrl);
    assert.equal(uploads, 0);
    store.close();
});

test('only ascent editing URLs have report owners', () => {
    assert.equal(reportPhotoOwner('https://www.peakbagger.com/climber/ascentedit.aspx?cid=1&pid=2'), owner);
    assert.equal(reportPhotoOwner('https://www.peakbagger.com/climber/climber.aspx?cid=1'), null);
    assert.equal(reportPhotoOwner('https://www.peakbagger.com/climber/ascentedit.aspx?cid=1&cid=2'), null);
    assert.equal(reportPhotoOwner('https://www.peakbagger.com/climber/ascentedit.aspx?cid=1&aid=2&pid=3'), null);
});

test('upload alone is not insertion; exact report acknowledgements add one bounded draft reference', async () => {
    let uploads = 0;
    const { service, store } = await harness(async () => { uploads++; return { remote, deleteUrl: 'https://ibb.co/abc/delete' }; });
    try {
        const { localPhotoId } = await service.create(owner, image);
        await assert.rejects(service.confirmInsertion(owner, { localPhotoId, url: remote.url }), /does not match/);
        await service.uploadOne(owner, localPhotoId);
        assert.equal((await store.getBundle(localPhotoId)).photo.references.length, 0);
        await assert.rejects(service.confirmInsertion('bpbReportDraft:2:p2', { localPhotoId, url: remote.url }), /unavailable/);
        await assert.rejects(service.confirmInsertion(owner, { localPhotoId, url: 'https://i.ibb.co/other.png' }), /does not match/);
        await service.confirmInsertion(owner, { localPhotoId, url: remote.url });
        const first = (await store.getBundle(localPhotoId)).photo;
        await service.confirmInsertion(owner, { localPhotoId, url: remote.url });
        const last = (await store.getBundle(localPhotoId)).photo;
        assert.deepEqual(last.references, [{ kind: 'ascent-draft', cid: 1, aid: null, pid: 2, insertedAt: first.references[0].insertedAt }]);
        assert.equal(last.revision, first.revision);
        await service.uploadOne(owner, localPhotoId);
        assert.equal(uploads, 1);
    } finally { store.close(); }
});

test('a failed reference write preserves the uploaded photo and retries without another upload', async () => {
    const indexedDB = new IDBFactory();
    let fail = false, uploads = 0;
    const openStore = async () => {
        const store = await Store.createPhotoStore({ indexedDB });
        const put = store.putPhoto;
        store.putPhoto = photo => { if (fail) throw new Error('disk full'); return put(photo); };
        return store;
    };
    const service = createReportPhotoService({ openStore, permissionGranted: async () => true,
        keyStore: { getKey: async () => 'key' }, upload: async () => { uploads++; return { remote, deleteUrl: 'https://ibb.co/abc/delete' }; } });
    const { localPhotoId } = await service.create(owner, image);
    await service.uploadOne(owner, localPhotoId);
    fail = true;
    await assert.rejects(service.confirmInsertion(owner, { localPhotoId, url: remote.url }), /reference could not be recorded/);
    const store = await openStore();
    try {
        assert.equal((await store.getBundle(localPhotoId)).photo.remote.state, 'uploaded');
        assert.equal((await store.getBundle(localPhotoId)).photo.references.length, 0);
        fail = false;
        await service.confirmInsertion(owner, { localPhotoId, url: remote.url });
        assert.equal((await store.getBundle(localPhotoId)).photo.references.length, 1);
        assert.equal(uploads, 1);
    } finally { store.close(); }
});

test('a resumed report draft returns under the same id and still rejects another report owner', async () => {
    const { service, store } = await harness(async () => { throw new Error('must not upload'); });
    const created = await service.create(owner, image);
    const edit = { localPhotoId: created.localPhotoId, dataUrl: 'data:image/png;base64,ZWRpdA==' };
    await assert.rejects(service.saveEdit('other-report', edit, created.localPhotoId), /unavailable/);
    const result = await service.saveEdit(owner, edit, created.localPhotoId);
    assert.equal(result.localPhotoId, created.localPhotoId);
    assert.equal((await service.read(owner, result.localPhotoId)).image.dataUrl, edit.dataUrl);
    assert.equal((await store.listPhotos()).length, 1);
    store.close();
});


test('a malformed real client success retains its journal across service restart', async () => {
    const indexedDB = new IDBFactory();
    const openStore = () => Store.createPhotoStore({ indexedDB });
    let posts = 0;
    const createService = () => createReportPhotoService({ openStore,
        permissionGranted: async () => true, keyStore: { getKey: async () => 'private-key' },
        upload: options => Client.upload({ ...options, fetch: async () => {
            posts++;
            return { ok: true, status: 200, text: async () => 'null' };
        } }) });
    const service = createService();
    const created = await service.create(owner, image);
    await assert.rejects(service.uploadOne(owner, created.localPhotoId), /could not read/);
    await assert.rejects(createService().uploadOne(owner, created.localPhotoId), /earlier upload may have reached/);
    const store = await openStore();
    assert.equal(posts, 1);
    assert.equal((await store.getOperations())[0].state, 'request-started');
    store.close();
});
