// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl } from '../reports/instagram-url.js';
import { trustedActions as TrustedActions } from './trusted-actions.js';

const KEY='bpbInstagramFrameGrants';
const TTL=60_000;
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
export function createInstagramFrames({ext,settings,trustedActions,isPeakbaggerSender,mutateMap,now=Date.now,randomToken}) {
    const token=randomToken||(()=>{const bytes=new Uint8Array(24);globalThis.crypto.getRandomValues(bytes);return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');});
    const frameUrl=new URL(ext.runtime.getURL('reports/instagram.html'));
    const source=sender=>{
        if(!isPeakbaggerSender(sender)||sender.frameId!==0||!Number.isInteger(sender.tab?.id))return false;
        try{return /^\/climber\/ascent(?:edit)?\.aspx$/i.test(new URL(sender.url).pathname);}catch{return false;}
    };
    const sameTab=async(record)=>{try{return (await ext.tabs.get(record.tabId)).url===record.sourceUrl;}catch{return false;}};
    const prune=records=>{for(const [key,value]of Object.entries(records))if(!value||value.expiresAt<=now())delete records[key];};
    const issue=async(message,sender)=>{
        const url=canonicalInstagramUrl(message.url);
        if(!source(sender)||!url||typeof message.sourceNonce!=='string'||!(/^[a-f0-9-]{32,64}$/i.test(message.sourceNonce)))return {ok:false};
        const automatic=message.automatic===true;
        if(automatic){if((await settings.requireCurrent()).loadInstagramAutomatically!==true)return {ok:false};}
        else if(!trustedActions.consumeCapability(message,sender,TrustedActions.ACTIONS.INSTAGRAM_POST))return {ok:false};
        const record={tabId:sender.tab.id,sourceUrl:sender.url,documentId:sender.documentId||null,sourceNonce:message.sourceNonce,url,automatic,expiresAt:now()+TTL};
        if(!await sameTab(record))return {ok:false};
        return mutateMap(KEY,records=>{
            prune(records);
            if(Object.keys(records).length>=128)return {ok:false};
            let key;do{key=token();}while(records[key]);
            records[key]=record;return {ok:true,token:key};
        });
    };
    const claim=async(message,sender)=>{
        if(sender.id!==ext.runtime.id||!Number.isInteger(sender.tab?.id)||!(sender.frameId>0)||!validToken(message.token))return {ok:false};
        try{const url=new URL(sender.url);if(url.protocol!==frameUrl.protocol||url.host!==frameUrl.host||url.pathname!==frameUrl.pathname||url.search||url.hash!==`#${message.token}`)return {ok:false};}catch{return {ok:false};}
        return mutateMap(KEY,async records=>{
            prune(records);const record=records[message.token];
            if(!record||record.tabId!==sender.tab.id)return {ok:false};
            delete records[message.token];
            if(!await sameTab(record))return {ok:false};
            let active;
            try { active=await ext.tabs.sendMessage(record.tabId,{type:'INSTAGRAM_FRAME_SOURCE_CURRENT',nonce:record.sourceNonce},
                {frameId:0,...(record.documentId&&{documentId:record.documentId})}); } catch {return {ok:false};}
            if(active?.ok!==true)return {ok:false};
            if(record.automatic&&(await settings.requireCurrent()).loadInstagramAutomatically!==true)return {ok:false};
            return {ok:true,url:record.url,parentOrigin:new URL(record.sourceUrl).origin};
        });
    };
    return {handlers:{INSTAGRAM_FRAME_ISSUE:issue,INSTAGRAM_FRAME_CLAIM:claim},
        forgetTab:tabId=>mutateMap(KEY,records=>{prune(records);for(const [key,record]of Object.entries(records))if(record.tabId===tabId)delete records[key];})};
}
