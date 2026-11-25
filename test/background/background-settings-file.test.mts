// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsFileRoutes, type CreateSettingsFileRoutesOptions,
    type ImportStoreStates, type SettingsFileGarminAdapter, type SettingsFileGarminSnapshot,
    type SettingsFileGarminConnection } from '../../src/background/settings-file-routes.ts';
import { createSettingsStore } from '../../src/settings/settings.ts';
import { settingsTransfer as Transfer, type SettingsTransferPayload } from '../../src/settings/settings-transfer.ts';
import { imgbbAuth as ImgbbAuth, type ImgbbAuthRecord } from '../../src/photos/imgbb-auth.ts';
import { githubAuth as GithubAuth, type GithubAuthRecord } from '../../src/github/github-auth.ts';
import { createCustomOverlayStore, type CustomOverlayPrivateStore } from '../../src/background/custom-overlay-store.ts';
import { customLayerBackup } from '../../src/maps/custom-overlay-transfer.ts';
import type { CustomRegistry } from '../../src/maps/custom-overlay-schema.ts';
import { deferred } from '../helpers/deferred.mts';
import { fieldsOf } from '../helpers/result-fields.mts';
import { required } from '../helpers/required.mts';

const makeArea = <T extends Record<string, unknown>>(initial: T) => {
    const values: T & Record<string, unknown> = structuredClone(initial);
    return {
        values,
        async get(keys?: string | string[] | null) {
            const requested = Array.isArray(keys) ? keys : [String(keys)];
            return Object.fromEntries(requested.map(key => [key, structuredClone(values[key])]));
        },
        async set(patch: Record<string, unknown>) { Object.assign(values, structuredClone(patch)); },
        async remove(keys: string | string[]) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        },
    };
};

type VerifyConnection = CreateSettingsFileRoutesOptions['verifyGithubConnection'];
interface HarnessOptions {
    settings?: Record<string, unknown>;
    imgbb?: string | null;
    github?: Record<string, unknown> | null;
    garmin?: SettingsFileGarminAdapter | null;
    verifyGithubConnection?: VerifyConnection;
}

const harness = ({
    settings = { theme: 'dark', units: 'imperial' },
    imgbb = null,
    github = null,
    garmin = null,
    verifyGithubConnection = async connection => ({
        ok: true,
        auth: {
            token: connection.token,
            tokenType: 'bearer',
            scope: '',
            grantedAt: '2026-07-31T12:00:00.000Z',
            account: { login: connection.repository.owner, id: null },
            repo: {
                ...connection.repository,
                branch: 'main',
                fullName: `${connection.repository.owner}/${connection.repository.name}`,
            },
            installationId: 7,
        },
    }),
} : HarnessOptions = {}) => {
    const sync = makeArea({ bpbSettings: settings });
    const local = makeArea<Record<string, unknown>>({
        ...(imgbb ? {
            [ImgbbAuth.STORAGE_KEY]: { key: imgbb, savedAt: '2026-07-29T12:00:00.000Z' },
        } : {}),
        ...(github ? { [GithubAuth.STORAGE_KEY]: github } : {}),
    });
    const settingsStore = createSettingsStore({ area: sync, localArea: local, onChanged: null, sendMessage: null });
    const keyStore = ImgbbAuth.createKeyStore(local);
    const authStore = GithubAuth.createAuthStore(local);
    const privateRecords = new Map<string, unknown>();
    const privateStore: CustomOverlayPrivateStore = {
        // Test records share an in-memory map. The store selects the record type by key.
        get: async <T = unknown,>(key: string) => structuredClone(privateRecords.get(key)) as T | undefined,
        put: async (key, value) => {
            if (value == null) privateRecords.delete(key); else privateRecords.set(key, structuredClone(value));
            return value;
        },
        mutate: async <T = unknown, R = T | undefined>(key: string, change: (current: T | undefined) => R) => {
            const value = change(structuredClone(privateRecords.get(key)) as T | undefined);
            if (value == null) privateRecords.delete(key); else privateRecords.set(key, value);
            return value;
        },
    };
    const customLayers = createCustomOverlayStore({ storage: local, privateStore, canRead: () => true, canEdit: () => true, canReadPrivate: () => true });
    const ext: CreateSettingsFileRoutesOptions['ext'] = {
        runtime: {
            getURL: path => `chrome-extension://test-extension/${path}`,
            getManifest: () => ({ version: '3.3.0' }),
        },
    };
    const routes = createSettingsFileRoutes({
        ext, settings: settingsStore, keyStore, authStore, verifyGithubConnection, garmin,
        customLayers,
    });
    const exportFile = (...args: Parameters<typeof routes.handlers.SETTINGS_FILE_EXPORT>) => routes.handlers.SETTINGS_FILE_EXPORT(...args).then(fieldsOf);
    const importFile = (...args: Parameters<typeof routes.handlers.SETTINGS_FILE_IMPORT>) => routes.handlers.SETTINGS_FILE_IMPORT(...args).then(fieldsOf);
    return { exportFile, importFile, sync, local, settingsStore, keyStore, authStore, customLayers, privateRecords };
};

const optionsSender = {
    url: 'chrome-extension://test-extension/options/options.html#github-settings-backup',
};
const straySender = {
    url: 'chrome-extension://test-extension/options/favorites.html',
};

type Harness = ReturnType<typeof harness>;
type MutableSettingsFile = Omit<SettingsTransferPayload, 'schemaVersion'> & { schemaVersion: number };

// These fixtures intentionally vary a parsed file to exercise its wire format.
const rawFile = (content: string | undefined) => JSON.parse(required(content)) as MutableSettingsFile;
const parseFile = (content: string | undefined) => {
    const parsed = Transfer.parse(required(content));
    assert.ok(parsed.ok);
    return parsed;
};
const storedRegistry = (h: Harness) => h.local.values.bpbCustomMapOverlaysV1 as CustomRegistry;
const storedPreferences = (h: Harness) => h.local.values.bpbCustomMapOverlayPreferencesV1 as Record<string, number>;
const storedImgBBKey = (h: Harness) => (h.local.values[ImgbbAuth.STORAGE_KEY] as ImgbbAuthRecord).key;
const firstEditedSource = async (h: Harness) => {
    const edited = await h.customLayers.handle({ type: 'CUSTOM_OVERLAYS_GET' }, optionsSender);
    assert.ok(edited.ok);
    return required(edited.registry).sources[0];
};

const customSource = () => ({ id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Topo', kind: 'raster',
    source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } });
const savePrivate = (h: Harness, value: string, revision = 0) => h.customLayers.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id: customSource().id,
    expectedRevision: revision, source: customSource(), requestParameters: [{ key: 'api_key', value }] }, optionsSender);

for (const concurrent of ['save', 'remove']) for (const imported of ['file-key', null]) {
    test(`ImgBB import preserves concurrent ${concurrent} when the file key is ${imported === null ? 'null' : 'present'}`, async () => {
        const h = harness({ imgbb: 'original-key' });
        await savePrivate(h, 'original-map-key');
        const file = rawFile((await h.exportFile({}, optionsSender)).content);
        file.settings.theme = 'light'; file.apiKeys = { imgbb: imported };
        const replace = h.customLayers.replaceIfCurrent;
        let first = true;
        h.customLayers.replaceIfCurrent = async (...args) => {
            const result = await replace(...args);
            if (first) {
                first = false;
                if (concurrent === 'save') await h.keyStore.setKey('newer-user-key');
                else await h.keyStore.clear();
            }
            return result;
        };
        const reply = await h.importFile({ content: JSON.stringify(file) }, optionsSender);
        assert.equal(await h.keyStore.getKey(), concurrent === 'save' ? 'newer-user-key' : null,
            'import must not overwrite a newer Save or restore a removed key');
        assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'rollback-conflict');
        assert.equal(reply.stores?.imgbb, 'conflicted');
        assert.equal(reply.stores?.settings, 'rolled-back'); assert.equal(reply.stores?.customLayers, 'rolled-back');
        assert.equal(h.sync.values.bpbSettings.theme, 'dark');
        const restored = await h.customLayers.snapshot({ includePrivate: true });
        assert.equal(required(restored.privateSources)[0].parameters[0].value, 'original-map-key');
    });
}

test('manual exports include private map configuration by default and restore it outside public storage', async () => {
    const h = harness(); assert((await savePrivate(h, 'map-secret')).ok);
    const exported = await h.exportFile({}, optionsSender);
    assert(exported.ok); assert(required(exported.content).includes('map-secret'), 'manual settings exports must carry private map parameters');
    const parsed = parseFile(exported.content); assert(parsed.ok);
    const privateLayer = required(parsed.privateCustomLayers)[0].source;
    assert.ok(privateLayer.kind === 'raster');
    assert.equal(privateLayer.source.tiles[0], customSource().source.tiles[0]);
    assert(!JSON.stringify(customLayerBackup(await h.customLayers.snapshot())).includes('map-secret'), 'ordinary GitHub snapshots stay public');
    assert(!('apiKeys' in parsed), 'account credentials keep their separate opt-in');
    const destination = harness(); assert((await savePrivate(destination, 'old-secret')).ok);
    const imported = await destination.importFile({ content: exported.content }, optionsSender);
    assert(imported.ok); const edited = await firstEditedSource(destination);
    assert.deepEqual(edited.requestParameters, [{ key: 'api_key', value: 'map-secret' }]);
    assert.equal(edited.revision, 2);
    assert.ok(edited.kind === 'raster');
    assert.match(edited.source.tiles[0], /\/2\/tile/);
    assert(!JSON.stringify(destination.local.values).includes('map-secret'));
    assert(!JSON.stringify(await destination.customLayers.snapshot()).includes('map-secret'));
});

test('failed account import rolls private map definitions and parameters back as well', async () => {
    const h = harness(); await savePrivate(h, 'original-map-key');
    const other = harness(); await savePrivate(other, 'replacement-map-key');
    const exported = rawFile((await other.exportFile({}, optionsSender)).content);
    exported.apiKeys = { imgbb: 'new-imgbb-key' };
    h.keyStore.replaceIfCurrent = async () => { throw new Error('simulated account write failure'); };
    const reply = await h.importFile({ content: JSON.stringify(exported) }, optionsSender);
    assert.equal(reply.ok, false); assert.equal(reply.stores?.customLayers, 'rolled-back');
    const edited = await firstEditedSource(h);
    assert.deepEqual(edited.requestParameters, [{ key: 'api_key', value: 'original-map-key' }]);
    assert(!JSON.stringify(h.local.values).includes('original-map-key'));
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
});
test('malformed, mismatched and falsely backported private map files reject before writing', async () => {
    const h = harness(); await savePrivate(h, 'original-map-key');
    const original = rawFile((await h.exportFile({}, optionsSender)).content);
    const changes: ((file: MutableSettingsFile) => void)[] = [
        file => { file.schemaVersion = 6; },
        file => { required(file.privateCustomLayers).push(structuredClone(required(file.privateCustomLayers)[0])); },
        file => { required(file.privateCustomLayers)[0].source.name = 'Mismatched layer'; },
        file => {
            const source = required(file.privateCustomLayers)[0].source;
            assert.ok(source.kind === 'raster');
            source.source.tiles[0] = 'https://127.0.0.1/{z}/{x}/{y}.png';
            source.approvedOrigins = ['https://127.0.0.1'];
        },
        file => { required(file.privateCustomLayers)[0].parameters[0].value = ''; },
        file => { delete file.customLayers; },
    ];
    for (const change of changes) {
        const file = structuredClone(original); change(file);
        const reply = await h.importFile({ content: JSON.stringify(file) }, optionsSender);
        assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'invalid-file');
    }
    const edited = await firstEditedSource(h);
    assert.equal(required(edited.requestParameters)[0].value, 'original-map-key');
    assert.equal(edited.revision, 1);
});

test('private file replacement preserves concurrent edits, failed public writes and provider counters', async () => {
    const h = harness(); await savePrivate(h, 'original-map-key');
    const previous = await h.customLayers.snapshot({ includePrivate: true });
    const backup = { ...customLayerBackup(previous), privateSources: previous.privateSources };
    await savePrivate(h, 'newer-key', 1);
    assert.equal((await h.customLayers.replaceIfCurrent(previous, backup)).replaced, false);
    const current = await h.customLayers.snapshot({ includePrivate: true });
    const set = h.local.set; h.local.set = async () => { throw new Error('public commit failed'); };
    await assert.rejects(h.customLayers.replaceIfCurrent(current, backup), /public commit failed/);
    h.local.set = set;
    assert.deepEqual(await h.customLayers.snapshot({ includePrivate: true }), current, 'staged secrets do not change the active revision');
    h.privateRecords.set('budget:tiles.example.com', { count: 12 });
    const exported = required((await h.exportFile({}, optionsSender)).content);
    assert(!exported.includes('budget:')); assert(!exported.includes('"count"'));
    assert((await h.importFile({ content: exported }, optionsSender)).ok);
    assert.deepEqual(h.privateRecords.get('budget:tiles.example.com'), { count: 12 });
});

test('legacy descriptor restores remove saved private values and require reconnection', async () => {
    const h = harness(); await savePrivate(h, 'original-map-key');
    const exported = rawFile((await h.exportFile({}, optionsSender)).content);
    delete exported.privateCustomLayers; exported.schemaVersion = 6;
    assert((await h.importFile({ content: JSON.stringify(exported) }, optionsSender)).ok);
    const edited = await firstEditedSource(h);
    assert.equal(edited.reconnect, true);
    assert.equal(h.privateRecords.has(customSource().id), false);
});

test('settings files export and atomically replace layers while legacy files preserve them', async () => {
    const h = harness(), source = customSource();
    h.local.values.bpbCustomMapOverlaysV1 = { schemaVersion: 1, revision: 8, sources: [source] };
    h.local.values.bpbCustomMapOverlayPreferencesV1 = { [source.id]: 27 };
    const exported = await h.exportFile({}, optionsSender);
    const parsed = parseFile(exported.content); assert.equal(required(parsed.customLayers).preferences[source.id], 27);
    const legacy = Transfer.serialize(Transfer.buildPayload({ theme: 'light' }));
    assert.equal((await h.importFile({ content: legacy }, optionsSender)).ok, true);
    assert.equal(storedRegistry(h).sources.length, 1);
    const payload = Transfer.buildPayload({ theme: 'dark' }, { customLayers: { schemaVersion: 1, sources: [{ ...source, name: 'Restored topo' }], preferences: { [source.id]: 44 } } });
    assert.equal((await h.importFile({ content: Transfer.serialize(payload) }, optionsSender)).ok, true);
    assert.equal(storedRegistry(h).sources[0].name, 'Restored topo');
    assert.equal(storedRegistry(h).sources[0].revision, 2); assert.equal(storedRegistry(h).generation, 1);
    assert.equal(storedPreferences(h)[source.id], 44);
    const invalid = structuredClone(payload);
    const invalidSource = required(invalid.customLayers).sources[0];
    assert.ok(invalidSource.kind === 'raster');
    invalidSource.source.tiles[0] = 'http://unsafe.example.com';
    assert.equal((await h.importFile({ content: JSON.stringify(invalid) }, optionsSender)).ok, false);
    assert.equal(storedPreferences(h)[source.id], 44);
});
test('later credential failure rolls imported custom layers back without losing prior sources', async () => {
    const h = harness(), source = customSource();
    h.local.values.bpbCustomMapOverlaysV1 = { schemaVersion: 1, revision: 8, sources: [source] };
    h.local.values.bpbCustomMapOverlayPreferencesV1 = { [source.id]: 27 };
    const before = customLayerBackup({ registry: storedRegistry(h), preferences: storedPreferences(h) });
    h.keyStore.replaceIfCurrent = async () => { throw new Error('simulated credential write failure'); };
    const payload = Transfer.buildPayload({ theme: 'light' }, { customLayers: { schemaVersion: 1, sources: [], preferences: {} }, apiKeys: { imgbb: 'new-key' } });
    const reply = await h.importFile({ content: Transfer.serialize(payload) }, optionsSender);
    assert.equal(reply.ok, false); assert.equal(reply.stores?.customLayers, 'rolled-back');
    assert.deepEqual(customLayerBackup({ registry: storedRegistry(h), preferences: storedPreferences(h) }), before);
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
});
test('an unreadable or corrupt custom library cannot become an empty settings export', async () => {
    const h = harness(); h.local.values.bpbCustomMapOverlaysV1 = { schemaVersion: 99, sources: [] };
    const reply = await h.exportFile({}, optionsSender);
    assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'settings-unavailable'); assert.equal(reply.content, undefined);
    assert.deepEqual(h.local.values.bpbCustomMapOverlaysV1, { schemaVersion: 99, sources: [] });
});

test('a manual file export is credential-free unless the user opts in', async () => {
    const h = harness({ imgbb: 'secret-imgbb-key' });
    const response = await h.exportFile({}, optionsSender);

    assert.equal(response.ok, true);
    const parsed = parseFile(response.content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.theme, 'dark');
    // The ImgBB key used to ride along on every export while the GitHub token
    // required a checkbox. One opt-in now covers both, so a file exported to
    // share carries neither.
    assert.equal('apiKeys' in parsed, false);
    assert.equal('githubConnection' in parsed, false);
    assert.match(required(response.exportedAt), /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(
        (await h.exportFile({}, straySender)).error?.code,
        'forbidden'
    );
});

test('opting in carries the API key even with no GitHub connection to export', async () => {
    const h = harness({ imgbb: 'secret-imgbb-key' });
    const response = await h.exportFile(
        { includeCredentials: true }, optionsSender
    );

    assert.equal(response.ok, true);
    const parsed = parseFile(response.content);
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

    const ordinary = parseFile((await h.exportFile({}, optionsSender)).content);
    assert.equal('githubConnection' in ordinary, false);

    const optedIn = await h.exportFile({
        includeCredentials: true,
    }, optionsSender);
    assert.equal(optedIn.ok, true);
    assert.deepEqual(parseFile(optedIn.content).githubConnection, {
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
    const imported = await h.importFile({
        content: Transfer.serialize(configured),
    }, optionsSender);

    assert.equal(imported.ok, true);
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.equal(h.sync.values.bpbSettings.units, 'metric');
    assert.equal(storedImgBBKey(h), 'new-imgbb-key');

    const empty = Transfer.buildPayload({ theme: 'dark' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T13:00:00.000Z',
        apiKeys: { imgbb: null },
    });
    assert.equal((await h.importFile({
        content: Transfer.serialize(empty),
    }, optionsSender)).ok, true);
    assert.equal(h.local.values[ImgbbAuth.STORAGE_KEY], undefined);
});

test('a direct oversized import message is rejected before any settings or credential access', async () => {
    let verified = 0;
    const h = harness({ verifyGithubConnection: async () => { verified += 1; return { ok: false }; } });
    let touched = 0;
    const unexpectedAccess = async () => { touched += 1; throw new Error('must not touch stores'); };
    h.settingsStore.requireCurrent = unexpectedAccess;
    h.settingsStore.applyPatch = unexpectedAccess;
    h.settingsStore.replaceIfCurrent = unexpectedAccess;
    h.keyStore.read = unexpectedAccess;
    h.keyStore.replace = unexpectedAccess;
    h.keyStore.replaceIfCurrent = unexpectedAccess;
    h.authStore.read = unexpectedAccess;
    h.authStore.readSnapshot = unexpectedAccess;
    h.authStore.replaceIfSnapshot = unexpectedAccess;
    const response = await h.importFile({
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
    const response = await h.importFile({ content: legacy }, optionsSender);

    assert.equal(response.ok, true);
    assert.equal(response.apiKeysImported, false);
    assert.equal(storedImgBBKey(h), 'keep-imgbb-key');
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
    const response = await h.importFile({
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
        account: { login: 'ada', id: null },
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
    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    const error = required(response.error);
    assert.ok('source' in error);
    assert.equal(error.source, 'github');
    assert.deepEqual(response.stores, {
        settings: 'not-written', imgbb: 'not-written', github: 'not-written',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(storedImgBBKey(h), 'old-imgbb-key');
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

    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'import-failed');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'rolled-back', github: 'not-written',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(storedImgBBKey(h), 'old-imgbb-key');
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], oldAuth);
});

test('a failed API-key write rolls settings back to their previous values', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const nativeReplace = h.keyStore.replaceIfCurrent;
    let failOnce = true;
    h.keyStore.replaceIfCurrent = async (expected, value) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('local write failed');
        }
        return nativeReplace(expected, value);
    };
    const payload = Transfer.buildPayload({ theme: 'light', units: 'metric' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'new-imgbb-key' },
    });
    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'import-failed');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'not-written', github: 'not-requested',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(h.sync.values.bpbSettings.units, 'imperial');
    assert.equal(storedImgBBKey(h), 'old-imgbb-key');
});

test('a newer settings patch survives rollback and is reported as a conflict', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const replace = h.keyStore.replaceIfCurrent;
    let first = true;
    h.keyStore.replaceIfCurrent = async (...args) => {
        if (first) {
            first = false;
            await h.settingsStore.applyPatch({ units: 'metric' });
            throw new Error('API key write failed');
        }
        return replace(...args);
    };
    const payload = Transfer.buildPayload({ theme: 'light', units: 'imperial' }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        apiKeys: { imgbb: 'imported-imgbb-key' },
    });

    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error?.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'conflicted', imgbb: 'not-written', github: 'not-requested',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'light');
    assert.equal(h.sync.values.bpbSettings.units, 'metric');
    assert.equal(storedImgBBKey(h), 'old-imgbb-key');
    const error = required(response.error);
    assert.ok('message' in error);
    assert.doesNotMatch(error.message, /nothing was changed/i);
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

    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error?.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'conflicted', github: 'not-written',
    });
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
    assert.equal(storedImgBBKey(h), 'newer-imgbb-key');
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

    const response = await h.importFile({
        content: Transfer.serialize(payload),
    }, optionsSender);

    assert.equal(response.error?.code, 'rollback-conflict');
    assert.deepEqual(response.stores, {
        settings: 'rolled-back', imgbb: 'not-requested', github: 'conflicted',
    });
    assert.deepEqual(h.local.values[GithubAuth.STORAGE_KEY], newerAuth);
});

test('two settings-file imports validate and commit in owner order', async () => {
    const gate = deferred<void>(), started = deferred<void>();
    const validationOrder: string[] = [];
    const verifyGithubConnection: VerifyConnection = async connection => {
        validationOrder.push(connection.token);
        if (connection.token === 'ghu_first_token') {
            started.resolve();
            await gate.promise;
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
    const content = (token: string, theme: string) => Transfer.serialize(Transfer.buildPayload({ theme }, {
        extensionVersion: '3.3.0',
        exportedAt: '2026-07-30T12:00:00.000Z',
        githubConnection: { token, repository: { owner: 'ada', name: 'peaks' } },
    }));

    const first = h.importFile({
        content: content('ghu_first_token', 'light'),
    }, optionsSender);
    await started.promise;
    const second = h.importFile({
        content: content('ghu_second_token', 'dark'),
    }, optionsSender);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(validationOrder, ['ghu_first_token']);

    gate.resolve();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.deepEqual(validationOrder, ['ghu_first_token', 'ghu_second_token']);
    assert.equal((h.local.values[GithubAuth.STORAGE_KEY] as GithubAuthRecord).token, 'ghu_second_token');
    assert.equal(h.sync.values.bpbSettings.theme, 'dark');
});

for (const failedStore of ['settings', 'imgbb', 'github']) {
    test(`rollback failure at the ${failedStore} write boundary reports every store`, async () => {
        const h = harness({ imgbb: 'old-imgbb-key', github: {
            token: 'ghu_old_token', repo: { owner: 'old', name: 'backup' },
        } });
        if (failedStore === 'settings') {
            const nativeReplace = h.settingsStore.replaceIfCurrent; let calls = 0;
            h.settingsStore.replaceIfCurrent = async (...args) => {
                if (++calls === 1) {
                    await nativeReplace(...args);
                    throw new Error('ambiguous settings write failure');
                }
                throw new Error('settings rollback failed');
            };
        } else if (failedStore === 'imgbb') {
            const nativeReplace = h.keyStore.replaceIfCurrent;
            let first = true;
            h.keyStore.replaceIfCurrent = async (expected, value) => {
                if (first) {
                    first = false;
                    await nativeReplace(expected, value);
                    throw new Error('ambiguous ImgBB write failure');
                }
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

        const response = await h.importFile({
            content: Transfer.serialize(payload),
        }, optionsSender);

        assert.equal(response.error?.code, 'rollback-failed');
        const expected = {
            settings: failedStore === 'settings' ? 'rollback-failed' : 'rolled-back',
            imgbb: failedStore === 'settings' ? 'not-written'
                : failedStore === 'imgbb' ? 'rollback-failed' : 'rolled-back',
            github: failedStore === 'github' ? 'rollback-failed' : 'not-written',
        };
        assert.deepEqual(response.stores, expected);
        const error = required(response.error);
        assert.ok('message' in error);
        assert.match(error.message, /Reload Settings and review/);
    });
}

type GarminFixtureConnection = SettingsFileGarminConnection & { owner?: string; enabled?: boolean };
type GarminFixtureSnapshot = SettingsFileGarminSnapshot & { connection: GarminFixtureConnection | null };
const garminTransfer = () => {
    let snapshot: GarminFixtureSnapshot = { epoch: 1, connection: { key: 'old-fictional-garmin-key', owner: '123', enabled: true } };
    let reads = 0;
    return {
        readSnapshot: async () => { reads++; return structuredClone(snapshot); },
        verifyImportedKey: async (key: string | null, previous: SettingsFileGarminSnapshot) => key === null ? { ...previous.connection, key: null, enabled: false } : { ...previous.connection, key },
        replaceIfSnapshot: async (expected: SettingsFileGarminSnapshot, connection: SettingsFileGarminConnection | null) => {
            if (JSON.stringify(expected) !== JSON.stringify(snapshot)) return { replaced: false };
            snapshot = { epoch: snapshot.epoch + 1, connection: structuredClone(connection) }; return { replaced: true };
        },
        current: () => structuredClone(snapshot), reads: () => reads,
        supersede: () => { snapshot.epoch++; required(snapshot.connection).key = 'newer-fictional-garmin-key'; },
    };
};
test('Garmin is read and exported only with the existing credential checkbox', async () => {
    const garmin = garminTransfer(); const h = harness({ garmin });
    const ordinary = await h.exportFile({}, optionsSender);
    assert.equal(garmin.reads(), 0); assert.equal(required(ordinary.content).includes('old-fictional-garmin-key'), false);
    const sensitive = await h.exportFile({ includeCredentials: true }, optionsSender);
    assert.equal(parseFile(sensitive.content).apiKeys?.garmin, 'old-fictional-garmin-key');
    assert.equal(required(sensitive.content).includes('access_token'), false);
});
test('legacy settings files omit Garmin without touching its connection', async () => {
    const garmin = garminTransfer(); const h = harness({ garmin });
    const file: MutableSettingsFile = Transfer.buildPayload({ theme: 'light' }, { apiKeys: { imgbb: null } });
    file.schemaVersion = 3;
    assert.equal((await h.importFile({ content: Transfer.serialize(file) }, optionsSender)).ok, true);
    assert.equal(garmin.reads(), 0); assert.equal(garmin.current().connection?.key, 'old-fictional-garmin-key');
});
test('Garmin-only key import preserves ImgBB; explicit null removes only Garmin', async () => {
    const garmin = garminTransfer(); const h = harness({ garmin, imgbb: 'preserved-imgbb-key' });
    const file = Transfer.buildPayload({}, { apiKeys: { garmin: null } });
    assert.equal((await h.importFile({ content: Transfer.serialize(file) }, optionsSender)).ok, true);
    assert.equal(garmin.current().connection?.key, null); assert.equal(garmin.current().connection?.enabled, false);
    assert.equal((await h.keyStore.read())?.key, 'preserved-imgbb-key');
});
test('invalid Garmin import changes no settings or connection', async () => {
    const garmin = garminTransfer(); garmin.verifyImportedKey = async () => { throw new Error('rejected'); };
    const h = harness({ garmin }); const before = await h.settingsStore.requireCurrent();
    const file = Transfer.buildPayload({ theme: 'light' }, { apiKeys: { garmin: 'replacement-fictional-garmin-key' } });
    const response = await h.importFile({ content: Transfer.serialize(file) }, optionsSender);
    assert.equal(response.ok, false); assert.deepEqual(await h.settingsStore.requireCurrent(), before);
    assert.equal(garmin.current().connection?.key, 'old-fictional-garmin-key');
});
test('concurrent Garmin replacement wins over an older file import', async () => {
    const garmin = garminTransfer(); const verify = garmin.verifyImportedKey;
    garmin.verifyImportedKey = async (...args) => { const result = await verify(...args); garmin.supersede(); return result; };
    const h = harness({ garmin });
    const file = Transfer.buildPayload({ theme: 'light' }, { apiKeys: { garmin: 'replacement-fictional-garmin-key' } });
    assert.equal((await h.importFile({ content: Transfer.serialize(file) }, optionsSender)).ok, false);
    assert.equal(garmin.current().connection?.key, 'newer-fictional-garmin-key');
    assert.equal((await h.settingsStore.requireCurrent()).theme, 'dark');
});
test('failed settings write rolls back the installed Garmin key conditionally', async () => {
    const garmin = garminTransfer(); const h = harness({ garmin });
    h.settingsStore.replaceIfCurrent = async () => { throw new Error('unavailable'); };
    const file = Transfer.buildPayload({}, { apiKeys: { garmin: 'replacement-fictional-garmin-key' } });
    const response = await h.importFile({ content: Transfer.serialize(file) }, optionsSender);
    assert.equal(response.ok, false); assert.equal(response.stores?.garmin, 'rolled-back');
    assert.equal(garmin.current().connection?.key, 'old-fictional-garmin-key');
});

test('settings edits after the import snapshot are preserved instead of overwritten', async () => {
    const h = harness({ imgbb: 'old-imgbb-key' });
    const replace = h.settingsStore.replaceIfCurrent; let first = true;
    h.settingsStore.replaceIfCurrent = async (...args) => {
        if (first) { first = false; await h.settingsStore.applyPatch({ theme: 'system' }); }
        return replace(...args);
    };
    const file = Transfer.buildPayload({ theme: 'light' }, { apiKeys: { imgbb: 'new-imgbb-key' } });
    const result = await h.importFile({ content: Transfer.serialize(file) }, optionsSender);
    assert.equal(result.ok, false); assert.equal(result.stores?.settings, 'conflicted');
    assert.equal((await h.settingsStore.requireCurrent()).theme, 'system');
    assert.equal((await h.keyStore.read())?.key, 'old-imgbb-key');
});
test('Garmin-only imports report that credentials changed', async () => {
    const h = harness({ garmin: garminTransfer() });
    const file = Transfer.buildPayload({}, { apiKeys: { garmin: null } });
    const result = await h.importFile({ content: Transfer.serialize(file) }, optionsSender);
    assert.equal(result.ok, true); assert.equal(result.apiKeysImported, true);
});

for (const validation of ['github', 'garmin']) for (const edit of ['github-remove', 'github-save', 'imgbb-remove', 'imgbb-save', 'settings', 'layers']) {
    test(`newer ${edit} survives held ${validation} import verification`, async () => {
        const entered = deferred<void>(), held = deferred<void>();
        const pause = async () => { entered.resolve(); await held.promise; };
        const garmin = garminTransfer(), verifyGarmin = garmin.verifyImportedKey;
        garmin.verifyImportedKey = async (...args) => {
            if (validation === 'garmin') await pause();
            return verifyGarmin(...args);
        };
        const originalAuth = { token: 'ghu_original', repo: { owner: 'ada', name: 'original' } };
        const h = harness({ garmin, github: originalAuth, imgbb: 'original-key',
            verifyGithubConnection: async connection => {
                if (validation === 'github') await pause();
                return { ok: true, auth: { token: connection.token, repo: connection.repository } };
            } });
        await savePrivate(h, 'original-map-key');
        const file = rawFile((await h.exportFile({ includeCredentials: true }, optionsSender)).content);
        file.settings.theme = 'light'; required(file.apiKeys).imgbb = 'file-key'; required(file.apiKeys).garmin = 'file-fictional-garmin-key';
        file.githubConnection = { token: 'ghu_file', repository: { owner: 'ada', name: 'imported' } };
        const importing = h.importFile({ content: JSON.stringify(file) }, optionsSender);
        await entered.promise;
        if (edit === 'github-remove') await h.authStore.clear();
        if (edit === 'github-save') { await h.authStore.clear(); await h.authStore.replace(originalAuth); }
        if (edit === 'imgbb-remove') await h.keyStore.clear();
        if (edit === 'imgbb-save') await h.keyStore.setKey('newer-key');
        if (edit === 'settings') await h.settingsStore.applyPatch({ theme: 'system' });
        if (edit === 'layers') await savePrivate(h, 'newer-map-key', 1);
        held.resolve();
        const result = await importing;
        assert.equal(result.ok, false, 'an earlier import cannot replace a newer user action');
        assert.equal(result.error?.code, 'rollback-conflict');
        // Disconnect also changes legacy-derived settings, which can reject
        // the transaction before it reaches the credential write.
        const store = edit.split('-')[0] === 'layers' ? 'customLayers' : edit.split('-')[0];
        assert.equal(result.stores?.[store as keyof ImportStoreStates] === 'conflicted' || edit === 'github-remove' && result.stores?.settings === 'conflicted', true);
        assert.deepEqual(await h.authStore.read(), edit === 'github-remove' ? null : originalAuth);
        assert.equal(await h.keyStore.getKey(), edit === 'imgbb-remove' ? null : edit === 'imgbb-save' ? 'newer-key' : 'original-key');
        assert.equal((await h.settingsStore.requireCurrent()).theme, edit === 'settings' ? 'system' : 'dark');
        const { privateSources } = await h.customLayers.snapshot({ includePrivate: true });
        assert.equal(required(privateSources)[0].parameters[0].value,
            edit === 'layers' ? 'newer-map-key' : 'original-map-key');
        assert.equal(garmin.current().connection?.key, 'old-fictional-garmin-key');
    });
}
