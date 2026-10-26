// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstagramFrames} from '../../src/background/instagram-frames.js';
const url='https://www.instagram.com/p/fA9uwTtkSN/';
const sourceNonce='ab'.repeat(24);
const sourceUrl='https://www.peakbagger.com/climber/ascent.aspx?aid=1';
const source={id:'fixture',url:sourceUrl,tab:{id:7},frameId:0,documentId:'source-doc'};
function setup(){
    let automatic=false,currentUrl=sourceUrl,currentNonce=sourceNonce,time=1,sequence=0,queue=Promise.resolve();const records={};
    const ext={runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path},tabs:{get:async()=>({url:currentUrl}),sendMessage:async(_id,msg)=>({ok:msg.nonce===currentNonce})}};
    const service=createInstagramFrames({ext,settings:{requireCurrent:async()=>({loadInstagramAutomatically:automatic})},
        trustedActions:{consumeCapability:message=>message.activationToken==='trusted'},isPeakbaggerSender:s=>s===source,
        now:()=>time,randomToken:()=>String(++sequence).padStart(48,'0'),mutateMap:(_key,mutate)=>{const result=queue.then(()=>mutate(records));queue=result.catch(()=>{});return result;}});
    const issue=(patch={},sender=source)=>service.handlers.INSTAGRAM_FRAME_ISSUE({url,sourceNonce,activationToken:'trusted',...patch},sender);
    const child=token=>({id:'fixture',url:'chrome-extension://fixture/reports/instagram.html#'+token,tab:{id:7},frameId:2});
    const claim=(token,sender=child(token))=>service.handlers.INSTAGRAM_FRAME_CLAIM({token},sender);
    return {issue,claim,child,service,records,automatic:value=>{automatic=value;},navigate:value=>{currentUrl=value;},newDocument:()=>{currentNonce='new-document';},expire:()=>{time+=60001;}};
}
test('one trusted post grants one child frame and only its canonical URL',async()=>{
    const s=setup();const issued=await s.issue();assert(issued.ok);
    const results=await Promise.all([s.claim(issued.token),s.claim(issued.token)]);
    assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>r.ok).url,url);
    assert.equal(results.find(r=>r.ok).parentOrigin,'https://www.peakbagger.com');assert.equal(Object.keys(s.records).length,0);
});
test('automatic loading requires current consent at issue and claim',async()=>{
    const s=setup();assert.equal((await s.issue({automatic:true})).ok,false);
    s.automatic(true);const issued=await s.issue({automatic:true});assert(issued.ok);s.automatic(false);
    assert.equal((await s.claim(issued.token)).ok,false);
    const manual=await s.issue();assert((await s.claim(manual.token)).ok);
});
test('synthetic activation, malformed URLs, wrong senders and wrong tabs cannot claim a post',async()=>{
    const s=setup();assert.equal((await s.issue({activationToken:'synthetic'})).ok,false);
    assert.equal((await s.issue({url:'https://evil.test/p/x'})).ok,false);
    assert.equal((await s.issue({}, {...source,frameId:1})).ok,false);
    const issued=await s.issue();
    for(const patch of [{id:'other'},{frameId:0},{tab:{id:8}},{url:'chrome-extension://fixture/options/options.html#'+issued.token}]){
        assert.equal((await s.claim(issued.token,{...s.child(issued.token),...patch})).ok,false);
    }
    assert((await s.claim(issued.token)).ok);
});
test('expiry, navigation, same-URL document replacement and tab cleanup revoke pending frames',async()=>{
    for(const change of [s=>s.expire(),s=>s.navigate(sourceUrl+'&new=1'),s=>s.newDocument(),s=>s.service.forgetTab(7)]){
        const s=setup();const issued=await s.issue();await change(s);assert.equal((await s.claim(issued.token)).ok,false);
    }
});
