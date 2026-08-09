// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportDraftRoutes, reportDraftRoutes as Routes }
    from '../../src/background/report-draft-routes.js';

const CLOCK = Date.parse('2026-08-08T12:00:00.000Z');

const makeArea = initial => {
    const values = structuredClone(initial || {});
    return {
        values,
        async get(key) {
            if (key === null) return structuredClone(values);
            if (Array.isArray(key)) {
                return Object.fromEntries(key.map(item => [item, structuredClone(values[item])]));
            }
            return { [key]: structuredClone(values[key]) };
        },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) {
            for (const item of Array.isArray(key) ? key : [key]) delete values[item];
        },
    };
};

const harness = ({ localInitial, localRemove } = {}) => {
    const local = makeArea(localInitial);
    if (localRemove) local.remove = key => localRemove(key, local);
    const session = makeArea();
    let clock = CLOCK;
    let queue = Promise.resolve();
    const mutateMap = (key, mutate) => {
        const operation = queue.then(async () => {
            const map = structuredClone(session.values[key] || {});
            const result = await mutate(map);
            await session.set({ [key]: map });
            return result;
        });
        queue = operation.catch(() => {});
        return operation;
    };
    const routes = createReportDraftRoutes({
        ext: { storage: { local } },
        now: () => clock,
        isPeakbaggerSender: sender => sender?.url?.startsWith('https://www.peakbagger.com/'),
        isExtensionPage: sender => sender?.url?.startsWith('chrome-extension://test/'),
        mutateMap,
    });
    return {
        routes,
        local,
        session,
        advance(ms) { clock += ms; },
    };
};

const addSender = {
    url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=33&cid=22',
    tab: { id: 41 },
};
const editSender = {
    url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=778899&cid=22',
    tab: { id: 41 },
};
const extensionSender = { url: 'chrome-extension://test/options/drafts.html' };
const ADD_ATTEMPT = 'add-attempt-1';
const pendingRecord = (text, attemptId = ADD_ATTEMPT) => ({
    text,
    savedAt: 1,
    pendingSave: { attemptId },
});

const registerAdd = h => h.routes.handlers.REPORT_DRAFT_SAVE_PENDING({
    draftKey: 'bpbReportDraft:22:p33',
    identity: { cid: '22', aid: null, pid: '33' },
    attemptId: ADD_ATTEMPT,
}, addSender);

test('pending Save accepts only the exact ascent editor identity and source tab', async () => {
    const h = harness();
    assert.equal((await registerAdd(h)).ok, true);
    const stored = h.session.values[Routes.PENDING_KEY]['41'];
    assert.equal(stored.draftKey, 'bpbReportDraft:22:p33');
    assert.deepEqual(stored.identity, { cid: '22', aid: null, pid: '33' });
    assert.equal(stored.attemptId, ADD_ATTEMPT);
    assert.equal(stored.sourceTabId, 41);
    assert.equal(stored.expiresAt - stored.requestedAt, Routes.TTL_MS);

    for (const [message, sender] of [
        [{ draftKey: 'bpbReportDraft:22:p34', identity: { cid: '22', pid: '34' }, attemptId: 'attempt' }, addSender],
        [{ draftKey: 'bpbReportDraft:22:p33', identity: { cid: '23', pid: '33' }, attemptId: 'attempt' }, addSender],
        [{ draftKey: 'bpbReportDraft:22:p33', identity: { cid: '22', pid: '33' }, attemptId: 'attempt' }, {
            ...addSender, url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
        }],
        [{ draftKey: 'bpbReportDraft:22:p33', identity: { cid: '22', pid: '33' }, attemptId: 'attempt' }, {
            ...addSender, tab: {},
        }],
    ]) {
        assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_PENDING(message, sender)).ok, false);
    }
});

test('Add success consumes only the pending draft from the matching tab and form', async () => {
    const key = 'bpbReportDraft:22:p33';
    const h = harness({ localInitial: { [key]: pendingRecord('recovery') } });
    await registerAdd(h);

    for (const sender of [
        { ...addSender, tab: { id: 42 } },
        { ...addSender, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=34&cid=22' },
        { ...addSender, url: 'https://www.peakbagger.com/climber/ascentedit.aspx?pid=33&cid=23' },
    ]) {
        const result = await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, sender);
        assert.equal(result.ok, false);
        assert.ok(h.local.values[key]);
    }

    assert.deepEqual(
        await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender),
        { ok: true, draftKey: key, removed: true },
    );
    assert.equal(h.local.values[key], undefined);
    assert.equal(h.session.values[Routes.PENDING_KEY]['41'], undefined);
    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender)).ok, false,
        'a duplicate success postback must be idempotent');
});

test('Edit success requires both the URL aid and confirmed aid to match', async () => {
    const key = 'bpbReportDraft:22:a778899';
    const editAttempt = 'edit-attempt-1';
    const h = harness({ localInitial: { [key]: pendingRecord('edited recovery', editAttempt) } });
    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_PENDING({
        draftKey: key,
        identity: { cid: '22', aid: '778899', pid: null },
        attemptId: editAttempt,
    }, editSender)).ok, true);

    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778898' }, editSender)).ok, false);
    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, {
        ...editSender,
        url: 'https://www.peakbagger.com/climber/ascentedit.aspx?aid=778898&cid=22',
    })).ok, false);
    assert.ok(h.local.values[key]);

    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, editSender)).ok, true);
    assert.equal(h.local.values[key], undefined);
});

test('confirmed success retains a newer same-key draft from another tab', async () => {
    const key = 'bpbReportDraft:22:p33';
    const h = harness({ localInitial: { [key]: pendingRecord('first attempt') } });
    await registerAdd(h);
    h.local.values[key] = pendingRecord('newer tab recovery', 'other-tab-attempt');

    assert.deepEqual(
        await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender),
        { ok: true, draftKey: key, removed: false },
    );
    assert.equal(h.local.values[key].text, 'newer tab recovery');
    assert.equal(h.session.values[Routes.PENDING_KEY]['41'], undefined);
});

test('a failed local removal keeps the confirmation retryable', async () => {
    const key = 'bpbReportDraft:22:p33';
    let fail = true;
    const h = harness({
        localInitial: { [key]: pendingRecord('do not lose this') },
        localRemove: async (item, area) => {
            if (fail) {
                fail = false;
                throw new Error('storage unavailable');
            }
            delete area.values[item];
        },
    });
    await registerAdd(h);

    await assert.rejects(
        h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender),
        /storage unavailable/,
    );
    assert.ok(h.local.values[key]);
    assert.ok(h.session.values[Routes.PENDING_KEY]['41']);

    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender)).ok, true);
    assert.equal(h.local.values[key], undefined);
});

test('replacement registration waits until an earlier confirmation is fully consumed', async () => {
    const key = 'bpbReportDraft:22:p33';
    let releaseRemoval;
    const h = harness({
        localInitial: { [key]: pendingRecord('first attempt') },
        localRemove: async (item, area) => {
            await new Promise(resolve => { releaseRemoval = resolve; });
            delete area.values[item];
        },
    });
    await registerAdd(h);
    const confirmation = h.routes.handlers.REPORT_DRAFT_SAVE_CONFIRMED({ aid: '778899' }, addSender);
    while (!releaseRemoval) await new Promise(resolve => setTimeout(resolve, 0));

    let replacementDone = false;
    const replacement = registerAdd(h).then(result => {
        replacementDone = true;
        return result;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(replacementDone, false);

    releaseRemoval();
    assert.equal((await confirmation).ok, true);
    assert.equal((await replacement).ok, true);
    assert.ok(h.session.values[Routes.PENDING_KEY]['41']);
});

test('discard, tab close, and expiry remove only pending worker state', async () => {
    const key = 'bpbReportDraft:22:p33';
    const h = harness({ localInitial: { [key]: { text: 'local copy', savedAt: 1 } } });
    await registerAdd(h);
    assert.equal((await h.routes.handlers.REPORT_DRAFT_SAVE_CANCEL({ draftKey: key }, addSender)).ok, true);
    assert.ok(h.local.values[key], 'explicit editor deletion owns the local removal');
    assert.equal(h.session.values[Routes.PENDING_KEY]['41'], undefined);

    await registerAdd(h);
    await h.routes.forgetTab(41);
    assert.equal(h.session.values[Routes.PENDING_KEY]['41'], undefined);

    await registerAdd(h);
    h.advance(Routes.TTL_MS + 1);
    await h.routes.cleanup(Date.parse('2026-08-08T12:00:00.000Z') + Routes.TTL_MS + 1);
    assert.equal(h.session.values[Routes.PENDING_KEY]['41'], undefined);
    assert.ok(h.local.values[key], 'worker-state expiry must not delete recovery data');
});

test('delete and restore use a generation barrier that preserves a newer same-key autosave', async () => {
    const key = 'bpbReportDraft:22:a778899';
    const older = { text: 'older snapshot', mode: 'rich', savedAt: CLOCK - 2 };
    const newer = { text: 'newer editor work', mode: 'rich', savedAt: CLOCK + 1 };
    const h = harness({ localInitial: { [key]: older } });

    const deletion = await h.routes.handlers.REPORT_DRAFT_DELETE({
        draftKey: key,
        expectedGeneration: null,
        expectedSavedAt: older.savedAt,
    }, extensionSender);
    assert.equal(deletion.deleted, true);
    assert.equal(h.local.values[key].deletedGeneration, deletion.generation);

    const delayed = await h.routes.handlers.REPORT_DRAFT_WRITE({
        draftKey: key,
        record: { ...older, text: 'delayed pre-delete write' },
    }, editSender);
    assert.equal(delayed.written, false);
    assert.equal(h.local.values[key].deletedGeneration, deletion.generation);

    const write = await h.routes.handlers.REPORT_DRAFT_WRITE({ draftKey: key, record: newer }, editSender);
    assert.equal(write.ok, true);
    const restore = await h.routes.handlers.REPORT_DRAFT_RESTORE({
        draftKey: key,
        generation: deletion.generation,
        record: deletion.record,
    }, extensionSender);
    assert.deepEqual(restore, { ok: true, draftKey: key, restored: false, reason: 'changed' });
    assert.equal(h.local.values[key].text, 'newer editor work');
});

test('a second manager cannot delete or restore through another manager generation', async () => {
    const key = 'bpbReportDraft:22:a778899';
    const record = { text: 'one copy', mode: 'rich', savedAt: CLOCK - 1 };
    const h = harness({ localInitial: { [key]: record } });
    const first = await h.routes.handlers.REPORT_DRAFT_DELETE({
        draftKey: key,
        expectedGeneration: null,
        expectedSavedAt: record.savedAt,
    }, extensionSender);
    const second = await h.routes.handlers.REPORT_DRAFT_DELETE({
        draftKey: key,
        expectedGeneration: null,
        expectedSavedAt: record.savedAt,
    }, extensionSender);
    assert.equal(second.deleted, false);

    await h.routes.handlers.REPORT_DRAFT_REMOVE({ draftKey: key }, editSender);
    const restore = await h.routes.handlers.REPORT_DRAFT_RESTORE({
        draftKey: key,
        generation: first.generation,
        record,
    }, extensionSender);
    assert.equal(restore.restored, false, 'an editor removal must invalidate an older manager Undo');
});

test('bulk restore resolves conflicts per key without suppressing unrelated recovery', async () => {
    const firstKey = 'bpbReportDraft:22:a778899';
    const secondKey = 'bpbReportDraft:22:p33';
    const first = { text: 'first old', mode: 'rich', savedAt: CLOCK - 2 };
    const second = { text: 'second old', mode: 'rich', savedAt: CLOCK - 3 };
    const h = harness({ localInitial: { [firstKey]: first, [secondKey]: second } });
    const deletion = await h.routes.handlers.REPORT_DRAFT_DELETE_MANY({ entries: [
        { draftKey: firstKey, expectedGeneration: null, expectedSavedAt: first.savedAt },
        { draftKey: secondKey, expectedGeneration: null, expectedSavedAt: second.savedAt },
    ] }, extensionSender);
    assert.equal(deletion.results.filter(result => result.deleted).length, 2);

    await h.routes.handlers.REPORT_DRAFT_WRITE({
        draftKey: firstKey,
        record: { text: 'first newer', mode: 'rich', savedAt: CLOCK + 1 },
    }, editSender);
    const restoration = await h.routes.handlers.REPORT_DRAFT_RESTORE_MANY({
        entries: deletion.results.map(result => ({
            draftKey: result.draftKey,
            generation: result.generation,
            record: result.record,
        })),
    }, extensionSender);
    assert.equal(restoration.results.find(result => result.draftKey === firstKey).restored, false);
    assert.equal(restoration.results.find(result => result.draftKey === secondKey).restored, true);
    assert.equal(h.local.values[firstKey].text, 'first newer');
    assert.equal(h.local.values[secondKey].text, 'second old');
});

test('Undo expiry removes only its exact tombstone generation', async () => {
    const key = 'bpbReportDraft:22:a778899';
    const record = { text: 'expire me', mode: 'rich', savedAt: CLOCK - 1 };
    const h = harness({ localInitial: { [key]: record } });
    const deletion = await h.routes.handlers.REPORT_DRAFT_DELETE({
        draftKey: key,
        expectedGeneration: null,
        expectedSavedAt: record.savedAt,
    }, extensionSender);
    const finalized = await h.routes.handlers.REPORT_DRAFT_FINALIZE_DELETE({
        draftKey: key,
        generation: deletion.generation,
    }, extensionSender);
    assert.deepEqual(finalized, { ok: true, finalized: true });
    assert.equal(h.local.values[key], undefined);

    await h.routes.handlers.REPORT_DRAFT_WRITE({
        draftKey: key,
        record: { text: 'newer', mode: 'rich', savedAt: CLOCK + 1 },
    }, editSender);
    assert.equal((await h.routes.handlers.REPORT_DRAFT_FINALIZE_DELETE({
        draftKey: key,
        generation: deletion.generation,
    }, extensionSender)).finalized, false);
    assert.equal(h.local.values[key].text, 'newer');
});
