// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    chromePublisherArguments, publishChromeFromReceipt, readChromeReceipt, uploadChrome,
    type ChromeUploadOptions, type ChromeUploadReceipt,
} from '../../scripts/publish-chrome.mts';

const NOW = Date.now();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const options = (): ChromeUploadOptions => ({ token: 'PRIVATE_TOKEN', publisherId: 'publisher-123',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop', packageBytes: new Uint8Array([1, 2, 3]),
    expectedVersion: '4.2.0', sourceCommit: 'a'.repeat(40), now: () => NOW, pollIntervalMs: 0, maxPolls: 1 });
const submitted = (version = '4.2.0', state = 'PENDING_REVIEW') => ({
    submittedItemRevisionStatus: { state, distributionChannels: [{ crxVersion: version }] },
});
function mockClient(responses: unknown[]) {
    const calls: { url: string; method?: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
        calls.push({ url: url.toString(), method: init?.method });
        assert.ok(responses.length, 'unexpected API request');
        return json(responses.shift());
    };
    return { calls, fetchImpl };
}
async function uploadedReceipt(): Promise<ChromeUploadReceipt> {
    return uploadChrome({ ...options(), ...mockClient([{}, { uploadState: 'SUCCEEDED' }]) });
}

test('split CLI requires explicit metadata review and rejects missing, unknown and extra arguments', () => {
    assert.deepEqual(chromePublisherArguments(['release.zip']), { mode: 'combined', archive: 'release.zip' });
    assert.deepEqual(chromePublisherArguments(['upload', 'release.zip', 'receipt.json']),
        { mode: 'upload', archive: 'release.zip', receipt: 'receipt.json' });
    assert.deepEqual(chromePublisherArguments(['publish', 'release.zip', 'receipt.json', '--metadata-reviewed']),
        { mode: 'publish', archive: 'release.zip', receipt: 'receipt.json' });
    for (const args of [[], ['upload'], ['publish'], ['publish', 'release.zip', 'receipt.json'],
        ['upload', 'release.zip', 'receipt.json', '--metadata-reviewed'],
        ['publish', 'release.zip', 'receipt.json', '--metadata-reviewed', '--metadata-reviewed'],
        ['--unknown'], ['publish', '--receipt', 'release.zip', '--metadata-reviewed']]) {
        assert.throws(() => chromePublisherArguments(args), /Usage/);
    }
});

test('upload-only sends private copied bytes, never publishes and does not invent an API-reported version', async () => {
    const original = options();
    let calls = 0;
    let sent: Uint8Array | undefined;
    const receipt = await uploadChrome({ ...original, fetchImpl: async (_url, init) => {
        calls++;
        if (calls === 1) { original.packageBytes.fill(9); return json({}); }
        assert.equal(calls, 2);
        sent = init?.body as Uint8Array;
        return json({ uploadState: 'SUCCEEDED' });
    } });
    assert.deepEqual(sent, new Uint8Array([1, 2, 3]));
    assert.equal(receipt.packageSha256, createHash('sha256').update(sent!).digest('hex'));
    assert.equal(receipt.outcome, 'uploaded');
    assert.equal(receipt.expectedVersion, '4.2.0');
    assert.equal(Object.hasOwn(receipt, 'apiReportedVersion'), false);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_TOKEN|token|currentDraft|draftDigest|uploadedVersion/);
});

test('upload processing permits absent async API version and rejects failed, unknown or mismatched outcomes', async () => {
    const client = mockClient([{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED' }]);
    const receipt = await uploadChrome({ ...options(), ...client });
    assert.equal(receipt.outcome, 'uploaded');
    assert.equal(client.calls.length, 3);
    assert.ok(client.calls.every(call => !call.url.endsWith(':publish')));
    for (const response of [{ uploadState: 'FAILED' }, { uploadState: 'UNKNOWN' },
        { uploadState: 'SUCCEEDED', crxVersion: '4.1.0' }, { uploadState: 'SUCCEEDED', crxVersion: '' }]) {
        const failed = mockClient([{}, response]);
        await assert.rejects(uploadChrome({ ...options(), ...failed }), /did not succeed|processed version/);
        assert.equal(failed.calls.length, 2);
    }
    const unknown = mockClient([{ lastAsyncUploadState: 'UNKNOWN' }]);
    await assert.rejects(uploadChrome({ ...options(), ...unknown }), /unknown upload state/);
    assert.equal(unknown.calls.length, 1);
});

test('new upload identity checks occur before any network request', async () => {
    let calls = 0;
    for (const patch of [{ sourceCommit: '' }, { sourceCommit: 'main' }, { expectedVersion: 'v4.2.0' },
        { repository: 'fork/repo' }]) {
        await assert.rejects(uploadChrome({ ...options(), ...patch, fetchImpl: async () => { calls++; return json({}); } }), /receipt requires/);
    }
    assert.equal(calls, 0);
});

test('publish-only requires human review and exact fresh receipt identity before contacting Google', async () => {
    const receipt = await uploadedReceipt();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return json({}); };
    await assert.rejects(publishChromeFromReceipt({ ...options(), fetchImpl, receipt, metadataReviewed: false }), /must be reviewed/);
    for (const patch of [{ schemaVersion: 2 }, { sourceCommit: 'b'.repeat(40) }, { expectedVersion: '4.1.0' },
        { repository: 'fork/repo' }, { publisherId: 'other' }, { extensionId: 'p'.repeat(32) },
        { packageSha256: 'f'.repeat(64) }, { createdAt: new Date(NOW + 1).toISOString() },
        { createdAt: new Date(NOW - 24 * 60 * 60_000 - 1).toISOString() }, { createdAt: 'invalid' },
        { outcome: 'unknown' }, { uploadState: 'FAILED' }, { apiReportedVersion: '4.1.0' }, { token: 'PRIVATE' }]) {
        await assert.rejects(publishChromeFromReceipt({ ...options(), fetchImpl,
            receipt: { ...receipt, ...patch }, metadataReviewed: true }), /receipt/);
    }
    await assert.rejects(publishChromeFromReceipt({ ...options(), packageBytes: new Uint8Array([9]),
        fetchImpl, receipt, metadataReviewed: true }), /does not match packageSha256/);
    assert.equal(calls, 0);
});

test('publish-only accepts missing async state for sync uploads and proves the exact submitted version', async () => {
    const receipt = await uploadedReceipt();
    for (const status of [{}, { lastAsyncUploadState: 'SUCCEEDED' }]) {
        const client = mockClient([status, { state: 'PENDING_REVIEW' }, submitted()]);
        const result = await publishChromeFromReceipt({ ...options(), ...client, receipt, metadataReviewed: true });
        assert.equal(result.uploadedVersion, '4.2.0');
        assert.equal(result.publishState, 'PENDING_REVIEW');
        assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
        assert.equal(client.calls.some(call => call.url.endsWith(':upload')), false);
        assert.ok(client.calls.find(call => call.method === 'POST')?.url.endsWith(':publish'));
    }
});

test('publish-only blocks contradictory upload or submission states before mutating', async () => {
    const receipt = await uploadedReceipt();
    for (const status of [{ lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'FAILED' },
        { lastAsyncUploadState: 'UPLOAD_FAILED' }, { lastAsyncUploadState: 'UNKNOWN' }, submitted('4.1.0'),
        { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [] } },
        { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '4.2.0' }] } }]) {
        const client = mockClient([status]);
        await assert.rejects(publishChromeFromReceipt({ ...options(), ...client, receipt, metadataReviewed: true }), /not ready|unproven|already published/);
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0]!.method, undefined);
    }
});

test('already-submitted receipts claim no upload and cannot publish if that exact submission disappears', async () => {
    const client = mockClient([submitted()]);
    const receipt = await uploadChrome({ ...options(), ...client });
    assert.equal(receipt.outcome, 'existing-submission');
    assert.equal(Object.hasOwn(receipt, 'uploadState'), false);
    assert.equal(Object.hasOwn(receipt, 'apiReportedVersion'), false);
    assert.equal(client.calls.length, 1);
    const exists = mockClient([submitted()]);
    assert.equal((await publishChromeFromReceipt({ ...options(), ...exists, receipt, metadataReviewed: true })).uploadedVersion, '4.2.0');
    assert.equal(exists.calls.length, 1);
    const disappeared = mockClient([{}]);
    await assert.rejects(publishChromeFromReceipt({ ...options(), ...disappeared, receipt, metadataReviewed: true }), /disappeared/);
    assert.equal(disappeared.calls.length, 1);
});

test('publish warnings and missing, rejected or mismatched remote version proof cannot become success', async () => {
    const receipt = await uploadedReceipt();
    const warnings = mockClient([{}, { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ description: 'Missing metadata' }] } }]);
    await assert.rejects(publishChromeFromReceipt({ ...options(), ...warnings, receipt, metadataReviewed: true }), /Missing metadata/);
    assert.equal(warnings.calls.length, 2);
    for (const status of [{}, submitted('4.1.0'), submitted('4.2.0', 'REJECTED'),
        { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [] } }]) {
        const client = mockClient([{}, { state: 'PENDING_REVIEW' }, status]);
        await assert.rejects(publishChromeFromReceipt({ ...options(), ...client, receipt, metadataReviewed: true }), /did not prove|expected|unexpected state|unproven/);
        assert.equal(client.calls.length, 3);
        assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
    }
});

test('ambiguous upload never mints a successful-upload receipt or replays upload', async () => {
    for (const reconciled of [false, true]) {
        let calls = 0;
        const promise = uploadChrome({ ...options(), requestTimeoutMs: 5, fetchImpl: async (_url, init) => {
            calls++;
            if (calls === 1) return json({});
            if (calls === 2) return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
            });
            assert.equal(calls, 3);
            return json(reconciled ? submitted() : { lastAsyncUploadState: 'SUCCEEDED' });
        } });
        if (reconciled) assert.equal((await promise).outcome, 'existing-submission');
        else await assert.rejects(promise, /outcome is unknown.*not replayed/);
        assert.equal(calls, 3);
    }
});

test('ambiguous publication reconciles exact version without replaying its POST or uploading', async () => {
    const receipt = await uploadedReceipt();
    for (const reconciled of [false, true]) {
        const calls: string[] = [];
        const promise = publishChromeFromReceipt({ ...options(), receipt, metadataReviewed: true, requestTimeoutMs: 5,
            fetchImpl: async (url, init) => {
                calls.push(url.toString());
                if (calls.length === 1) return json({});
                if (calls.length === 2) return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
                });
                assert.equal(calls.length, 3);
                return json(reconciled ? submitted() : {});
            } });
        if (reconciled) assert.equal((await promise).uploadedVersion, '4.2.0');
        else await assert.rejects(promise, /outcome is unknown.*not replayed/);
        assert.equal(calls.filter(url => url.endsWith(':publish')).length, 1);
        assert.equal(calls.some(url => url.endsWith(':upload')), false);
    }
});


test('malformed critical status fields fail before a new mutation', async () => {
    const receipt = await uploadedReceipt();
    for (const body of [null, [], { lastAsyncUploadState: false }, { submittedItemRevisionStatus: false },
        { submittedItemRevisionStatus: { distributionChannels: false } },
        { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: 123 }] } },
        { warningInfo: { warnings: false } }]) {
        for (const mode of ['upload', 'publish']) {
            const client = mockClient([body]);
            const request = mode === 'upload' ? uploadChrome({ ...options(), ...client })
                : publishChromeFromReceipt({ ...options(), ...client, receipt, metadataReviewed: true });
            await assert.rejects(request, /malformed JSON/);
            assert.equal(client.calls.length, 1);
            assert.equal(client.calls[0]!.method, undefined);
        }
    }
});


test('publication rejects receipts that expire during preflight without sending its POST', async () => {
    const receipt = await uploadedReceipt();
    let now = NOW + 24 * 60 * 60_000 - 1;
    const calls: string[] = [];
    await assert.rejects(publishChromeFromReceipt({ ...options(), receipt, metadataReviewed: true, now: () => now,
        fetchImpl: async (url, init) => {
            calls.push(url.toString());
            assert.equal(init?.method, undefined);
            now += 2;
            return json({});
        } }), /receipt is stale/);
    assert.equal(calls.length, 1);
});

test('publication uses a private receipt snapshot while waiting on remote preflight', async () => {
    const receipt = await uploadedReceipt();
    const client = mockClient([{}, { state: 'PENDING_REVIEW' }, submitted()]);
    const result = await publishChromeFromReceipt({ ...options(), receipt, metadataReviewed: true,
        fetchImpl: async (...args) => {
            receipt.sourceCommit = 'b'.repeat(40);
            return client.fetchImpl(...args);
        } });
    assert.equal(result.uploadedVersion, '4.2.0');
    assert.equal(client.calls.length, 3);
});

test('CLI reserves upload receipt before validation and retains an explicit failure tombstone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-chrome-receipt-test-'));
    try {
        const archive = path.join(root, 'package.zip'), receipt = path.join(root, 'receipt.json');
        await writeFile(archive, 'dummy bytes that must never be uploaded');
        await writeFile(receipt, 'existing protected receipt');
        const script = fileURLToPath(new URL('../../scripts/publish-chrome.mts', import.meta.url));
        const invoke = () => spawnSync(process.execPath, [script, 'upload', archive, receipt], { encoding: 'utf8',
            env: { ...process.env, CHROME_WEBSTORE_TOKEN: '', CHROME_PUBLISHER_ID: '', CHROME_EXTENSION_ID: '', GITHUB_SHA: '' } });
        const existing = invoke();
        assert.notEqual(existing.status, 0);
        assert.match(existing.stderr, /EEXIST/);
        assert.doesNotMatch(existing.stderr, /TOKEN is required/);
        assert.equal(await readFile(receipt, 'utf8'), 'existing protected receipt');
        await rm(receipt);
        const invalid = invoke();
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /reservation remains.*inspect the Developer Dashboard.*TOKEN is required/);
        assert.equal((await readChromeReceipt(receipt) as { outcome: string }).outcome, 'not-confirmed');
        assert.match(invoke().stderr, /EEXIST/, 'another run cannot consume a failed reservation');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('receipt file reading rejects over-budget input before JSON parsing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'bpb-chrome-receipt-budget-'));
    try {
        const filename = path.join(root, 'receipt.json');
        await writeFile(filename, 'x'.repeat(64 * 1024 + 1));
        await assert.rejects(readChromeReceipt(filename), /64KB budget/);
        await writeFile(filename, JSON.stringify({ outcome: 'fixture' }));
        assert.deepEqual(await readChromeReceipt(filename), { outcome: 'fixture' });
    } finally { await rm(root, { recursive: true, force: true }); }
});


test('release evidence expiry is checked at entry and again immediately before either mutation', async () => {
    const receipt = await uploadedReceipt();
    for (const mode of ['upload', 'publish']) {
        let now = NOW;
        const calls: string[] = [];
        const fetchImpl: typeof fetch = async (url, init) => {
            calls.push(url.toString());
            assert.equal(init?.method, undefined);
            now += 2;
            return json({});
        };
        const expired = { ...options(), now: () => now, fetchImpl,
            evidenceExpiresAt: new Date(NOW + 1).toISOString() };
        const promise = mode === 'upload' ? uploadChrome(expired)
            : publishChromeFromReceipt({ ...expired, receipt, metadataReviewed: true });
        await assert.rejects(promise, /verification evidence has expired/);
        assert.equal(calls.length, 1);
        for (const evidenceExpiresAt of ['invalid', new Date(NOW - 1).toISOString()]) {
            const input = { ...options(), evidenceExpiresAt, fetchImpl };
            await assert.rejects(mode === 'upload' ? uploadChrome(input)
                : publishChromeFromReceipt({ ...input, receipt, metadataReviewed: true }), /verification evidence has expired/);
            assert.equal(calls.length, 1, 'invalid or expired evidence must fail before preflight');
        }
    }
});


test('split modes require every present published and submitted channel version before mutation or reconciliation', async () => {
    const receipt = await uploadedReceipt();
    for (const key of ['publishedItemRevisionStatus', 'submittedItemRevisionStatus']) {
        for (const revision of [{}, { state: 'PUBLISHED' }, { state: 'PENDING_REVIEW', distributionChannels: [] },
            { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '4.2.0' }, {}] },
            { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '4.2.0' }, { crxVersion: '' }] },
            { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '4.2.0' }, { crxVersion: ' ' }] }]) {
            for (const mode of ['upload', 'publish']) {
                const client = mockClient([{ [key]: revision }]);
                await assert.rejects(mode === 'upload' ? uploadChrome({ ...options(), ...client })
                    : publishChromeFromReceipt({ ...options(), ...client, receipt, metadataReviewed: true }), /unproven.*distribution-channel versions/);
                assert.equal(client.calls.length, 1);
                assert.equal(client.calls[0]!.method, undefined, 'incomplete version proof must neither mutate nor claim an exact submitted match');
            }
        }
    }
});
