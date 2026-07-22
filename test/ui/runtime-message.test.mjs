// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeMessage as RuntimeMessage } from '../../src/ui/runtime-message.js';

test('runtime messaging shares one promise contract across extension surfaces', async () => {
    const extensionApi = {
        runtime: {
            async sendMessage(message) { return { echoed: message.type }; }
        }
    };
    const send = RuntimeMessage.bind(extensionApi);

    assert.deepEqual(await send({ type: 'PING' }), { echoed: 'PING' });
    assert.equal(await RuntimeMessage.send({
        runtime: { sendMessage: async () => { throw new Error('worker unavailable'); } }
    }, { type: 'PING' }), null);
    assert.equal(await RuntimeMessage.send({
        runtime: { sendMessage: async () => undefined }
    }, { type: 'PING' }), null);
});
