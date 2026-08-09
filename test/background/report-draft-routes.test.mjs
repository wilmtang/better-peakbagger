// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportDraftRoutes, reportDraftRoutes as Routes }
    from '../../src/background/report-draft-routes.js';

const makeArea = initial => {
    const values = structuredClone(initial || {});
    return {
        values,
        async get(key) { return { [key]: structuredClone(values[key]) }; },
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
    let clock = Date.parse('2026-08-08T12:00:00.000Z');
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
