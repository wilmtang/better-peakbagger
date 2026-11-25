// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import * as I from '../../src/favorites/ignored-climbers.ts';
import { createIgnoredStore } from '../../src/background/ignored-store.ts';
import {
    createClimberListSync, readIgnoredSyncState,
    type CreateClimberListSyncOptions, type IgnoredSyncClient, type IgnoredSyncPreview, type IgnoredSyncResponse,
    type IgnoredSyncState, type IgnoredSyncStorage,
} from '../../src/background/climber-list-sync.ts';
import { githubWriteQueue } from '../../src/github/github-write-queue.ts';

type Hook = (() => unknown) | null;

export const entry = (cid: number, name = `Climber ${cid}`) => ({ cid, name, addedAt: 1 });
export const harness = ({ local = [entry(1)], remote = null as I.IgnoredClimberEntry[] | null, syncEnabled = false as boolean | null } = {}) => {
    const values: Record<string, unknown> = { [I.IGNORED_KEY]: { schemaVersion: 1, revision: 1, entries: local } };
    // Existing coverage exercises explicit backup and reviewed setup. null
    // represents a fresh installation with no saved sync preference.
    if (syncEnabled !== null) values[I.SYNC_KEY] = { ...readIgnoredSyncState(undefined), enabled: syncEnabled };
    const state = { values, remote: remote === null ? null : I.serializeBackup(remote) as string | null, reads: 0, writes: 0,
        epoch: 1, readHook: null as Hook, commitHook: null as Hook, retryHook: null as Hook, beforeRefHook: null as Hook,
        failGet: false, failReconcile: false };
    const storage: IgnoredSyncStorage = {
        get: async key => { if (state.failGet) throw new Error('Storage unavailable');
            return Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, structuredClone(values[name])])); },
        set: async patch => { if (state.failReconcile && patch[I.IGNORED_KEY]) throw new Error('Storage unavailable after commit'); Object.assign(values, structuredClone(patch)); },
    };
    const store = createIgnoredStore({ storage });
    const client: IgnoredSyncClient = {
        readRootFile: async (path, options) => { assert.equal(path, I.BACKUP_PATH); assert.equal(options?.maxBytes, I.MAX_BYTES);
            state.reads++; await state.readHook?.(); return state.remote; },
        updateRootFile: async (path, update, _message, options) => {
            assert.equal(path, I.BACKUP_PATH); assert.equal(options?.maxBytes, I.MAX_BYTES);
            let text = await update(state.remote);
            if (state.retryHook) { await state.retryHook(); text = await update(state.remote); }
            await state.beforeRefHook?.(); await options?.beforeCommit?.();
            state.remote = text; state.writes++; await state.commitHook?.(); return { sha: 'confirmed' };
        },
    };
    const writeQueue = githubWriteQueue.createGithubWriteQueue({ commitFiles: () => assert.fail('semantic writes must be exclusive') });
    const engineOptions = { storage, store, writeQueue,
        getAccess: async () => ({ authorizationEpoch: state.epoch, repo: { owner: 'me', name: 'backup', branch: 'main' }, client }),
    } satisfies CreateClimberListSyncOptions;
    const h = Object.assign(state, { storage, store, client, engineOptions, engine: createClimberListSync(engineOptions) });
    // Tests may replace h.engine; confirmation goes through the current one.
    return Object.assign(h, { confirm: (preview: IgnoredSyncPreview, mode = 'merge', choices = {}) =>
        h.engine.action({ action: 'confirm', reviewId: preview.id, mode, choices }) });
};

// The sync state a successful status or action response carries.
export const syncState = (response: IgnoredSyncResponse): IgnoredSyncState => {
    assert.ok('state' in response && response.state, `expected a sync state, got ${JSON.stringify(response)}`);
    return response.state;
};
