// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { trustedActions as TrustedActions } from '../../src/background/trusted-actions.js';

const peakbagger = (tabId = 5, frameId = 0, documentId = 'document-a') => ({
    tab: { id: tabId },
    frameId,
    documentId,
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
});

const createStorage = () => {
    const values = {};
    return {
        values,
        area: {
            async get(key) { return { [key]: structuredClone(values[key]) }; },
            async set(patch) { Object.assign(values, structuredClone(patch)); },
        },
    };
};

const create = ({ storage = createStorage(), start = 1000 } = {}) => {
    let current = start;
    let sequence = 0;
    const actions = TrustedActions.create({
        storage: () => storage.area,
        isPeakbaggerSender: sender => sender?.url?.startsWith('https://www.peakbagger.com/'),
        now: () => current,
        randomToken: () => `token-${++sequence}`,
    });
    return { actions, storage, advance: ms => { current += ms; } };
};

test('activation capabilities are sender-bound, generation-bound, short-lived, and one-use', async () => {
    const { actions, advance } = create();
    const sender = peakbagger();
    const issued = actions.issue({ action: TrustedActions.ACTIONS.ASCENT_BACKUP, generation: '1' }, sender);

    assert.deepEqual(issued, { ok: true, token: 'token-1', expiresAt: 6000 });
    assert.equal(actions.consumeCapability({
        activationToken: issued.token,
        generation: '1',
    }, peakbagger(9), TrustedActions.ACTIONS.ASCENT_BACKUP), false);
    assert.equal(actions.consumeCapability({
        activationToken: issued.token,
        generation: '1',
    }, sender, TrustedActions.ACTIONS.ASCENT_BACKUP), false, 'a mismatch consumes the token');

    const wrongGeneration = actions.issue({
        action: TrustedActions.ACTIONS.BETA_SETTINGS,
        generation: 'settings-1',
    }, sender);
    assert.equal(actions.consumeCapability({
        activationToken: wrongGeneration.token,
        generation: 'settings-2',
    }, sender, TrustedActions.ACTIONS.BETA_SETTINGS), false);

    const expired = actions.issue({ action: TrustedActions.ACTIONS.BETA_SETTINGS, generation: 'settings-3' }, sender);
    advance(TrustedActions.CAPABILITY_TTL_MS);
    assert.equal(actions.consumeCapability({
        activationToken: expired.token,
        generation: 'settings-3',
    }, sender, TrustedActions.ACTIONS.BETA_SETTINGS), false);
});

test('workflow grants survive worker restart but remain bound and revocable', async () => {
    const first = create();
    const sender = peakbagger();
    const issued = first.actions.issue({
        action: TrustedActions.ACTIONS.PROFILE_BACKUP,
        generation: 'profile-4',
    }, sender);
    const begun = await first.actions.begin({
        action: TrustedActions.ACTIONS.PROFILE_BACKUP,
        generation: 'profile-4',
        activationToken: issued.token,
    }, sender);

    assert.equal(begun.ok, true);
    const restarted = create({ storage: first.storage });
    assert.equal(await restarted.actions.consumeGrant({
        grantToken: begun.grantToken,
        generation: 'profile-4',
    }, peakbagger(5, 0, 'document-b'), TrustedActions.ACTIONS.PROFILE_BACKUP), false);

    const replacementIssued = restarted.actions.issue({
        action: TrustedActions.ACTIONS.PROFILE_BACKUP,
        generation: 'profile-5',
    }, sender);
    const replacement = await restarted.actions.begin({
        action: TrustedActions.ACTIONS.PROFILE_BACKUP,
        generation: 'profile-5',
        activationToken: replacementIssued.token,
    }, sender);
    assert.equal(await restarted.actions.consumeGrant({
        grantToken: replacement.grantToken,
        generation: 'profile-5',
    }, sender, TrustedActions.ACTIONS.PROFILE_BACKUP), true);
    assert.deepEqual(await restarted.actions.end({
        grantToken: replacement.grantToken,
        generation: 'profile-5',
    }, sender), { ok: true });
    assert.equal(await restarted.actions.consumeGrant({
        grantToken: replacement.grantToken,
        generation: 'profile-5',
    }, sender, TrustedActions.ACTIONS.PROFILE_BACKUP), false);
});

test('one-use workflow grants cannot be replayed and tab cleanup revokes authority', async () => {
    const { actions } = create();
    const sender = peakbagger();
    const beginGrant = async generation => {
        const issued = actions.issue({
            action: TrustedActions.ACTIONS.ASCENT_BACKUP,
            generation,
        }, sender);
        return actions.begin({
            action: TrustedActions.ACTIONS.ASCENT_BACKUP,
            generation,
            activationToken: issued.token,
        }, sender);
    };

    const oneUse = await beginGrant('ascent-1');
    const message = { grantToken: oneUse.grantToken, generation: 'ascent-1' };
    assert.equal(await actions.consumeGrant(
        message,
        sender,
        TrustedActions.ACTIONS.ASCENT_BACKUP,
        { oneUse: true },
    ), true);
    assert.equal(await actions.consumeGrant(
        message,
        sender,
        TrustedActions.ACTIONS.ASCENT_BACKUP,
        { oneUse: true },
    ), false);

    const forgotten = await beginGrant('ascent-2');
    await actions.forgetTab(5);
    assert.equal(await actions.consumeGrant({
        grantToken: forgotten.grantToken,
        generation: 'ascent-2',
    }, sender, TrustedActions.ACTIONS.ASCENT_BACKUP), false);
});

test('unknown actions and malformed generations cannot mint authority', async () => {
    const { actions } = create();
    assert.deepEqual(actions.issue({ action: 'other', generation: '1' }, peakbagger()),
        { ok: false, reason: 'forbidden' });
    assert.deepEqual(actions.issue({ action: TrustedActions.ACTIONS.ASCENT_BACKUP, generation: 'bad generation' }, peakbagger()),
        { ok: false, reason: 'forbidden' });
    assert.deepEqual(actions.issue({ action: TrustedActions.ACTIONS.ASCENT_BACKUP, generation: '1' }, {
        tab: { id: 5 },
        url: 'https://evil.example/',
    }), { ok: false, reason: 'forbidden' });
});
