// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsFileRoutes } from '../../src/background/settings-file-routes.js';
import { settingsSchema as Schema } from '../../src/settings/settings-schema.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../../src/photos/imgbb-auth.js';
import { githubAuth as GithubAuth } from '../../src/github/github-auth.js';

const makeArea = (initial = {}) => {
    const values = structuredClone(initial);
    return {
        values,
        async get(key) { return { [key]: structuredClone(values[key]) }; },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; },
    };
};

const harness = ({
    settings = { theme: 'dark', units: 'imperial' },
    imgbb = null,
    github = null,
    verifyGithubConnection = async connection => ({
        ok: true,
        auth: {
            token: connection.token,
            tokenType: 'bearer',
            scope: '',
            grantedAt: '2026-07-31T12:00:00.000Z',
            account: { login: connection.repository.owner },
            repo: {
                ...connection.repository,
                branch: 'main',
                fullName: `${connection.repository.owner}/${connection.repository.name}`,
            },
            installationId: 7,
        },
    }),
} = {}) => {
    const sync = makeArea({ bpbSettings: settings });
    const local = makeArea({
        ...(imgbb ? {
            [ImgbbAuth.STORAGE_KEY]: { key: imgbb, savedAt: '2026-07-29T12:00:00.000Z' },
        } : {}),
        ...(github ? { [GithubAuth.STORAGE_KEY]: github } : {}),
    });
    const settingsStore = {
        requireCurrent: async () => Schema.clean((await sync.get('bpbSettings')).bpbSettings),
        applyPatch: async patch => {
            const current = Schema.clean((await sync.get('bpbSettings')).bpbSettings);
            const next = Schema.clean({ ...current, ...patch });
            await sync.set({ bpbSettings: next });
            return next;
        },
    };
    const keyStore = ImgbbAuth.createKeyStore(local);
    const authStore = GithubAuth.createAuthStore(local);
    const ext = {
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '3.3.0' }),
        },
    };
    const routes = createSettingsFileRoutes({
        ext, settings: settingsStore, keyStore, authStore, verifyGithubConnection,
    });
    return { routes, sync, local, settingsStore, keyStore, authStore };
};

const optionsSender = {
    url: 'chrome-extension://test-extension/options/options.html#github-settings-backup',
};
const straySender = {
    url: 'chrome-extension://test-extension/options/favorites.html',
};

test('a manual file export is credential-free unless the user opts in', async () => {
    const h = harness({ imgbb: 'secret-imgbb-key' });
    const response = await h.routes.handlers.SETTINGS_FILE_EXPORT({}, optionsSender);

    assert.equal(response.ok, true);
    const parsed = Transfer.parse(response.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark');
    // The ImgBB key used to ride along on every export while the GitHub token
    // required a checkbox. One opt-in now covers both, so a file exported to
    // share carries neither.
    assert.equal('apiKeys' in parsed, false);
    assert.equal('githubConnection' in parsed, false);
    assert.match(response.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(
        (await h.routes.handlers.SETTINGS_FILE_EXPORT({}, straySender)).error.code,
        'forbidden'
    );
});

test('opting in carries the API key even with no GitHub connection to export', async () => {
    const h = harness({ imgbb: 'secret-imgbb-key' });
    const response = await h.routes.handlers.SETTINGS_FILE_EXPORT(
        { includeCredentials: true }, optionsSender
    );

    assert.equal(response.ok, true);
    const parsed = Transfer.parse(response.content);
    assert.deepEqual(parsed.apiKeys, { imgbb: 'secret-imgbb-key' });
    // Asking for credentials on an unconnected profile is not an error; there
    // is simply no connection to add.
    assert.equal('githubConnection' in parsed, false);
});

test('manual file export includes the GitHub token and selected repository only after opt-in', async () => {
    const h = harness({
        github: {
            token: 'ghu_private_token',
            repo: { owner: 'ada', name: 'peaks', id: 123, branch: 'main', fullName: 'ada/peaks' },
            account: { login: 'ada' },
            installationId: 7,
        },
    });

    const ordinary = Transfer.parse((await h.routes.handlers.SETTINGS_FILE_EXPORT({}, optionsSender)).content);
    assert.equal('githubConnection' in ordinary, false);

    const optedIn = await h.routes.handlers.SETTINGS_FILE_EXPORT({
        includeCredentials: true,
    }, optionsSender);
    assert.equal(optedIn.ok, true);
    assert.deepEqual(Transfer.parse(optedIn.content).githubConnection, {
        token: 'ghu_private_token',
        repository: { owner: 'ada', name: 'peaks', id: 123 },
    });
});

test('manual file import replaces settings and the API key, including an explicit empty key', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const configured = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    const imported = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(configured),
    }, optionsSender);

    assert.equal(imported.ok, true);
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.equal(h.sync.values.bpbSettings.units, 'metric');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'new-imgbb-key');

    const empty = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T13:00:00.000Z',
        apiKeys: { imgbb: null },
    });
    assert.equal((await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(empty),
    }, optionsSender)).ok, true);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY], undefined);
});

test('legacy imports preserve the destination API key', async () => {
    const h = harness({ imgbb: 'keep-imgbb-key' });
    const legacy = JSON.stringify({
        kind: Transfer.KIND,
        schemaVersion: 1,
        settings: { theme: 'light' },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({ content: legacy }, optionsSender);

    assert.equal(response.ok, true);
    assert.equal(response.apiKeysImported, false);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'keep-imgbb-key');
});

test('manual file import validates and replaces the GitHub connection after confirmation', async () => {
    const oldAuth = {
        token: 'ghu_old_token',
        repo: { owner: 'old', name: 'backup', branch: 'main' },
    };
    const h = harness({ github: oldAuth });
    const payload = Transfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-31T12:00:00.000Z',
        githubConnection: {
            token: 'ghu_imported_token',
            repository: { owner: 'ada', name: 'peaks', id: 123 },
        },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, true);
    assert.equal(response.githubConnectionImported, true);
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], {
        token: 'ghu_imported_token',
        tokenType: 'bearer',
        scope: '',
        grantedAt: '2026-07-31T12:00:00.000Z',
        account: { login: 'ada' },
        repo: {
            owner: 'ada', name: 'peaks', id: 123, branch: 'main', fullName: 'ada/peaks',
        },
        installationId: 7,
    });
});

test('an unverifiable imported GitHub connection changes no local state', async () => {
    const oldAuth = {
        token: 'ghu_old_token',
        repo: { owner: 'old', name: 'backup', branch: 'main' },
    };
    const h = harness({
        imgbb: 'old-imgbb-key',
        github: oldAuth,
        verifyGithubConnection: async () => { throw new Error('offline'); },
    });
    const payload = Transfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-31T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
        githubConnection: {
            token: 'ghu_imported_token',
            repository: { owner: 'ada', name: 'peaks' },
        },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error.source, 'github');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], oldAuth);
});

test('a failed GitHub credential write rolls settings and API keys back', async () => {
    const oldAuth = {
        token: 'ghu_old_token',
        repo: { owner: 'old', name: 'backup', branch: 'main' },
    };
    const h = harness({ imgbb: 'old-imgbb-key', github: oldAuth });
    const nativeReplace = h.authStore.replace;
    let failOnce = true;
    h.authStore.replace = async value => {
        if (failOnce && value?.token === 'ghu_imported_token') {
            failOnce = false;
            throw new Error('auth write failed');
        }
        return nativeReplace(value);
    };
    const payload = Transfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-31T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
        githubConnection: {
            token: 'ghu_imported_token',
            repository: { owner: 'ada', name: 'peaks' },
        },
    });

    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'import-failed');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], oldAuth);
});

test('a failed API-key write rolls settings back to their previous values', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const nativeSetKey = h.keyStore.setKey;
    let failOnce = true;
    h.keyStore.setKey = async (...args) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('local write failed');
        }
        return nativeSetKey(...args);
    };
    const payload = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'import-failed');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.sync.values.bpbSettings.units, 'imperial');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
});
