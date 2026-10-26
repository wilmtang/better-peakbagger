// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, registerCleanup, waitFor } from '../helpers/options-helpers.mjs';
registerCleanup();

test('Instagram display access is explicitly requested, denial recovers, busy actions do not repeat, and removal is reflected',async()=>{
    let allowed=false,release,requests=0,removals=0,syncs=0;
    const dom=await loadOptions({}, {prepareChrome(api){
        api.permissions={contains:async()=>allowed,request:()=>{requests++;return new Promise(resolve=>{release=value=>{allowed=value;resolve(value);};});},
            remove:async()=>{removals++;allowed=false;return true;},onAdded:{addListener(){}},onRemoved:{addListener(){}}};
        const send=api.runtime.sendMessage.bind(api.runtime);
        api.runtime.sendMessage=message=>message.type==='INSTAGRAM_DISPLAY_SYNC'?(syncs++,Promise.resolve({ok:true})):send(message);
    }});
    const doc=dom.window.document,control=doc.getElementById('instagram-display-fixes');
    assert.equal(requests,0);assert.equal(control.checked,false);
    control.click();assert.equal(requests,1);assert.equal(control.getAttribute('aria-busy'),'true');
    control.click();assert.equal(requests,1,'pending permission requests must not repeat');
    release(false);await waitFor(dom,()=>control.getAttribute('aria-disabled')==='false'&&!control.checked);
    assert.match(doc.getElementById('status-error').textContent,/wasn’t granted/);
    control.click();release(true);await waitFor(dom,()=>syncs===1&&control.getAttribute('aria-disabled')==='false'&&control.checked);
    control.click();await waitFor(dom,()=>removals===1&&syncs===2&&!control.checked);
    assert.equal(control.hasAttribute('aria-busy'),false);
});
