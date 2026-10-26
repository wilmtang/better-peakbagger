// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramDisplayRegistration, INSTAGRAM_DISPLAY_ID } from '../../src/reports/instagram-display-registration.js';
test('Instagram display registration is serialized, grant-dependent and removable without requesting access',async()=>{
    let allowed=false,registered=[],requests=0;const changes=[],notified=[];
    const api={permissions:{contains:async()=>allowed,request:()=>{requests++;},onAdded:{addListener:fn=>changes.push(fn)},onRemoved:{addListener:fn=>changes.push(fn)}},
        scripting:{getRegisteredContentScripts:async()=>registered,registerContentScripts:async value=>{registered=value;},unregisterContentScripts:async()=>{registered=[];}}};
    const display=createInstagramDisplayRegistration(api,{onChanged:value=>notified.push(value)});
    assert.equal(await display.sync(),false);assert.deepEqual(registered,[]);
    allowed=true;await Promise.all([display.sync(),display.sync()]);
    assert.equal(registered.length,1);assert.equal(registered[0].id,INSTAGRAM_DISPLAY_ID);
    assert.deepEqual(registered[0].matches,['https://www.instagram.com/p/*/embed/captioned/*','https://www.instagram.com/reel/*/embed/captioned/*']);
    assert.equal(registered[0].allFrames,true);assert.equal(registered[0].runAt,'document_start');
    allowed=false;changes[1]();await display.sync();assert.deepEqual(registered,[]);assert.equal(requests,0);
    assert.equal(notified.at(-1),false,'permission changes notify active wrappers after registration is reconciled');
});
