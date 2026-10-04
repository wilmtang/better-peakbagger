// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.js';
import { createIgnoredStore } from '../../src/background/ignored-store.js';
import { createClimberListSync } from '../../src/background/climber-list-sync.js';
import { githubWriteQueue } from '../../src/github/github-write-queue.js';
export const entry = (cid, name = `Climber ${cid}`) => ({ cid, name, addedAt: 1 });
export const harness = ({ local = [entry(1)], remote = null } = {}) => {
    const values = { [I.IGNORED_KEY]: { schemaVersion: 1, revision: 1, entries: local } };
    const h = { values, remote: remote === null ? null : I.serializeBackup(remote), reads: 0, writes: 0,
        epoch: 1, readHook: null, commitHook: null, retryHook: null, failGet: false, failReconcile: false };
    h.storage = { get: async key => { if (h.failGet) throw new Error('Storage unavailable'); return { [key]: structuredClone(values[key]) }; },
        set: async patch => { if (h.failReconcile && patch[I.IGNORED_KEY]) throw new Error('Storage unavailable after commit'); Object.assign(values, structuredClone(patch)); } };
    h.store = createIgnoredStore({ storage: h.storage });
    h.client = {
        readRootFile: async (path, options) => { assert.equal(path, I.BACKUP_PATH); assert.equal(options.maxBytes, I.MAX_BYTES);
            h.reads++; await h.readHook?.(); return h.remote; },
        updateRootFile: async (path, update, message, options) => {
            assert.equal(path, I.BACKUP_PATH); assert.equal(options.maxBytes, I.MAX_BYTES);
            let text = await update(h.remote);
            if (h.retryHook) { await h.retryHook(); text = await update(h.remote); }
            await h.beforeRefHook?.(); await options.beforeCommit?.();
            h.remote = text; h.writes++; await h.commitHook?.(); return { sha: 'confirmed' };
        },
    };
    const writeQueue = githubWriteQueue.createGithubWriteQueue({ commitFiles: () => assert.fail('semantic writes must be exclusive') });
    h.engineOptions = { storage: h.storage, store: h.store, writeQueue,
        getAccess: async () => ({ authorizationEpoch: h.epoch, repo: { owner: 'me', name: 'backup', branch: 'main' }, client: h.client }) };
    h.engine = createClimberListSync(h.engineOptions);
    h.confirm = (preview, mode = 'merge', choices = {}) => h.engine.action({ action: 'confirm', reviewId: preview.id, mode, choices });
    return h;
};
