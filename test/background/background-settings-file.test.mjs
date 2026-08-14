// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsFileRoutes } from '../../src/background/settings-file-routes.js';
import { createSettingsStore } from '../../src/settings/settings.js';
import { settingsTransfer as Transfer } from '../../src/settings/settings-transfer.js';
import { imgbbAuth as ImgbbAuth } from '../../src/photos/imgbb-auth.js';
import { githubAuth as GithubAuth } from '../../src/github/github-auth.js';

const makeArea = (initial = {}) => {
    const values = structuredClone(initial);
    return {
        values,
        async get(keys) {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map(key => [key, structuredClone(values[key])]));
        },
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
    const settingsStore = createSettingsStore({ area: sync, onChanged: null, sendMessage: null });
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

test('a direct oversized import message is rejected before any settings or credential access', async () => {
    let verified = 0;
    const h = harness({ verifyGithubConnection: async () => { verified += 1; return { ok: false }; } });
    let touched = 0;
    for (const [store, methods] of [
        [h.settingsStore, ['requireCurrent', 'applyPatch', 'replaceIfCurrent']],
        [h.keyStore, ['read', 'replace', 'replaceIfCurrent']],
        [h.authStore, ['read', 'readSnapshot', 'replaceIfSnapshot']],
    ]) {
        for (const method of methods) {
            store[method] = async () => { touched += 1; throw new Error('must not touch stores'); };
        }
    }
    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: 'x'.repeat(Transfer.IMPORT_MAX_BYTES + 1),
    }, optionsSender);
    assert.deepEqual(response, {
        ok: false,
        error: { code: 'invalid-file', reason: 'too-large' },
    });
    assert.equal(touched, 0);
    assert.equal(verified, 0);
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
    assert.deepEqual(response.stores, {
        settings: 'not-written', imgbb: 'not-written', github: 'not-written',
    });
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
    const nativeReplaceIfSnapshot = h.authStore.replaceIfSnapshot;
    let failOnce = true;
    h.authStore.replaceIfSnapshot = async (expected, value) => {
        if (failOnce && value?.token === 'ghu_imported_token') {
            failOnce = false;
            throw new Error('auth write failed');
        }
        return nativeReplaceIfSnapshot(expected, value);
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
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'rolled-back', github: 'not-written',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], oldAuth);
});

test('a failed API-key write rolls settings back to their previous values', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const nativeReplace = h.keyStore.replace;
    let failOnce = true;
    h.keyStore.replace = async value => {
        if (failOnce) {
            failOnce = false;
            throw new Error('local write failed');
        }
        return nativeReplace(value);
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
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'not-written', github: 'not-requested',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.sync.values.bpbSettings.units, 'imperial');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
});

test('a newer settings patch survives rollback and is reported as a conflict', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    h.keyStore.replace = async () => {
        await h.settingsStore.applyPatch({ units: 'metric' });
        throw new Error('API key write failed');
    };
    const payload = Transfer.buildPayload({ theme: 'light', units: 'imperial' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'imported-imgbb-key' },
    });

    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'conflicted', imgbb: 'not-written', github: 'not-requested',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.equal(h.sync.values.bpbSettings.units, 'metric');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'old-imgbb-key');
    assert.doesNotMatch(response.error.message, /nothing was changed/i);
});

test('a newer API key survives rollback after a later GitHub write fails', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const nativeReplaceIfSnapshot = h.authStore.replaceIfSnapshot;
    let failOnce = true;
    h.authStore.replaceIfSnapshot = async (expected, replacement) => {
        if (!failOnce) return nativeReplaceIfSnapshot(expected, replacement);
        failOnce = false;
        await h.keyStore.setKey('newer-imgbb-key', '2026-08-08T12:00:00.000Z');
        throw new Error('GitHub write failed');
    };
    const payload = Transfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'imported-imgbb-key' },
        githubConnection: {
            token: 'ghu_imported_token',
            repository: { owner: 'ada', name: 'peaks' },
        },
    });

    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'conflicted', github: 'not-written',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY].key, 'newer-imgbb-key');
});

test('a disconnect and reconnect survive an ambiguous imported GitHub write failure', async () => {
    const oldAuth = { token: 'ghu_old_token', repo: { owner: 'old', name: 'backup' } };
    const newerAuth = { token: 'ghu_newer_token', repo: { owner: 'grace', name: 'summits' } };
    const h = harness({ github: oldAuth });
    const nativeReplaceIfSnapshot = h.authStore.replaceIfSnapshot;
    let failOnce = true;
    h.authStore.replaceIfSnapshot = async (expected, value) => {
        if (!failOnce) return nativeReplaceIfSnapshot(expected, value);
        failOnce = false;
        await nativeReplaceIfSnapshot(expected, value);
        await h.authStore.clear();
        await h.authStore.replace(newerAuth);
        throw new Error('ambiguous GitHub write failure');
    };
    const payload = Transfer.buildPayload({ theme: 'light' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        githubConnection: {
            token: 'ghu_imported_token',
            repository: { owner: 'ada', name: 'peaks' },
        },
    });

    const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'not-requested', github: 'conflicted',
    });
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], newerAuth);
});

test('two settings-file imports validate and commit in owner order', async () => {
    let releaseFirst;
    let firstValidationStarted;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstValidationStarted = resolve; });
    const validationOrder = [];
    const verifyGithubConnection = async connection => {
        validationOrder.push(connection.token);
        if (connection.token === 'ghu_first_token') {
            firstValidationStarted();
            await gate;
        }
        return {
            ok: true,
            auth: {
                token: connection.token,
                repo: { ...connection.repository, branch: 'main' },
            },
        };
    };
    const h = harness({ verifyGithubConnection });
    const content = (token, theme) => Transfer.serialize(Transfer.buildPayload({ theme }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        githubConnection: { token, repository: { owner: 'ada', name: 'peaks' } },
    }));

    const first = h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: content('ghu_first_token', 'light'),
    }, optionsSender);
    await started;
    const second = h.routes.handlers.SETTINGS_FILE_IMPORT({
        content: content('ghu_second_token', 'dark'),
    }, optionsSender);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(validationOrder, ['ghu_first_token']);

    releaseFirst();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.deepEqual(validationOrder, ['ghu_first_token', 'ghu_second_token']);
    assert.equal(h.local.values[GithubAuth.STORAGE_KEY].token, 'ghu_second_token');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
});

for (const failedStore of ['settings', 'imgbb', 'github']) {
    test(`rollback failure at the ${failedStore} write boundary reports every store`, async () => {
        const h = harness({ imgbb: 'old-imgbb-key', github: {
            token: 'ghu_old_token', repo: { owner: 'old', name: 'backup' },
        } });
        if (failedStore === 'settings') {
            const nativeApply = h.settingsStore.applyPatch;
            h.settingsStore.applyPatch = async patch => {
                await nativeApply(patch);
                throw new Error('ambiguous settings write failure');
            };
            h.settingsStore.replaceIfCurrent = async () => {
                throw new Error('settings rollback failed');
            };
        } else if (failedStore === 'imgbb') {
            const nativeReplace = h.keyStore.replace;
            h.keyStore.replace = async value => {
                await nativeReplace(value);
                throw new Error('ambiguous ImgBB write failure');
            };
            h.keyStore.replaceIfCurrent = async () => {
                throw new Error('ImgBB rollback failed');
            };
        } else {
            const nativeReplaceIfSnapshot = h.authStore.replaceIfSnapshot;
            let calls = 0;
            h.authStore.replaceIfSnapshot = async (expected, value) => {
                calls += 1;
                if (calls === 1) {
                    await nativeReplaceIfSnapshot(expected, value);
                    throw new Error('ambiguous GitHub write failure');
                }
                throw new Error('GitHub rollback failed');
            };
        }
        const payload = Transfer.buildPayload({ theme: 'light' }, {
            extensionVersion: '3.3.0',
            exportedAt: '2026-07-30T12:00:00.000Z',
            apiKeys: { imgbb: 'imported-imgbb-key' },
            githubConnection: {
                token: 'ghu_imported_token',
                repository: { owner: 'ada', name: 'peaks' },
            },
        });

        const response = await h.routes.handlers.SETTINGS_FILE_IMPORT({
            content: Transfer.serialize(payload),
        }, optionsSender);

        assert.equal(response.error.code, 'rollback-failed');
        const expected = {
            settings: failedStore === 'settings' ? 'rollback-failed' : 'rolled-back',
            imgbb: failedStore === 'settings' ? 'not-written'
                : failedStore === 'imgbb' ? 'rollback-failed' : 'rolled-back',
            github: failedStore === 'github' ? 'rollback-failed' : 'not-written',
        };
        assert.deepEqual(response.stores, expected);
        assert.match(response.error.message, /Reload Settings and review/);
    });
}
