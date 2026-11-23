// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramDisplayRegistration, INSTAGRAM_DISPLAY_ID, type InstagramDisplayRegistrationApi, type InstagramDisplayRegistrationScript } from '../../src/reports/instagram-display-registration.ts';
test('Instagram display registration is serialized, grant-dependent and removable without requesting access',async()=>{
    let allowed=false,registered:InstagramDisplayRegistrationScript[]=[],requests=0;const changes:(()=>void)[]=[],notified:boolean[]=[];
    // request is not part of the registration API; counting it proves the worker never asks.
    const api:InstagramDisplayRegistrationApi&{permissions:{request():void}}={permissions:{contains:async()=>allowed,request:()=>{requests++;},onAdded:{addListener:fn=>{changes.push(fn);}},onRemoved:{addListener:fn=>{changes.push(fn);}}},
        scripting:{getRegisteredContentScripts:async()=>registered,registerContentScripts:async value=>{registered=value;},unregisterContentScripts:async()=>{registered=[];}}};
    const display=createInstagramDisplayRegistration(api,{onChanged:value=>notified.push(value)});
    assert.equal(await display.sync(),false);assert.deepEqual(registered,[]);
    allowed=true;await Promise.all([display.sync(),display.sync()]);
    // Read through a function: the deepEqual above narrows the variable itself.
    const current=():InstagramDisplayRegistrationScript[]=>registered;const [script,...others]=current();
    assert.equal(others.length,0);assert.equal(script?.id,INSTAGRAM_DISPLAY_ID);
    assert.deepEqual(script?.matches,['https://www.instagram.com/p/*/embed/captioned/*','https://www.instagram.com/reel/*/embed/captioned/*']);
    assert.equal(script?.allFrames,true);assert.equal(script?.runAt,'document_start');
    allowed=false;changes[1]!();await display.sync();assert.deepEqual(registered,[]);assert.equal(requests,0);
    assert.equal(notified.at(-1),false,'permission changes notify active wrappers after registration is reconciled');
});
