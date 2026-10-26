// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl } from './instagram-url.js';
import { instagramEmbedHeight } from './instagram-sizing.js';
const api=globalThis.browser||globalThis.chrome;
const token=location.hash.slice(1);
let parentOrigin='*';
const report=(state,height)=>parent.postMessage({__bpbInstagram:state,...(height!==null&&height!==undefined&&{height})},parentOrigin);
(async()=>{
    try{
        const response=await api.runtime.sendMessage({type:'INSTAGRAM_FRAME_CLAIM',token});
        const url=response?.ok&&canonicalInstagramUrl(response.url);
        if(!url||!response.parentOrigin)throw new Error('unavailable');
        parentOrigin=response.parentOrigin;
        const frame=document.getElementById('post');
        let height=null,reported=false,complete=false,fallback=null;
        const finish=(allowFallback=false)=>{
            if(reported||!complete||(height===null&&!allowFallback))return;
            reported=true;clearTimeout(fallback);document.getElementById('status').hidden=true;report('loaded',height);
        };
        addEventListener('message',event=>{
            // Opaque sandbox origins serialize as "null". The actual child
            // WindowProxy, not that shared origin string, establishes identity.
            if(reported||event.source!==frame.contentWindow||event.origin!=='null'
                ||typeof event.data!=='string'||event.data.length>2048)return;
            try{
                const message=JSON.parse(event.data);
                if(message?.type==='MEASURE'){
                    height=instagramEmbedHeight(message.details?.height)??height;finish();
                }
            }catch{ /* Unknown provider messages never affect layout. */ }
        });
        frame.addEventListener('load',()=>{
            // Complete as soon as the loaded provider has measured its caption.
            // A missing/changed provider protocol falls back once to scrolling;
            // later measurements never bounce the report.
            complete=true;finish();
            if(!reported)fallback=setTimeout(()=>finish(true),1000);
        },{once:true});
        frame.addEventListener('error',()=>report('error'),{once:true});
        // The provider alone runs remote code, in a scripts-only opaque frame.
        // It receives neither extension APIs nor the Peakbagger document origin.
        // Give the provider its real width while the parent is still hidden,
        // so its caption-inclusive height is measured at the intended size.
        frame.hidden=false;
        frame.src=`${url}embed/captioned/`;
    }catch{
        document.getElementById('status').textContent='This post could not be loaded.';
        report('error');
    }
})();
