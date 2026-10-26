// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl } from './instagram-url.js';
const api=globalThis.browser||globalThis.chrome;
const token=location.hash.slice(1);
let parentOrigin='*';
const report=state=>parent.postMessage({__bpbInstagram:state},parentOrigin);
(async()=>{
    try{
        const response=await api.runtime.sendMessage({type:'INSTAGRAM_FRAME_CLAIM',token});
        const url=response?.ok&&canonicalInstagramUrl(response.url);
        if(!url||!response.parentOrigin)throw new Error('unavailable');
        parentOrigin=response.parentOrigin;
        const frame=document.getElementById('post');
        frame.addEventListener('load',()=>{document.getElementById('status').hidden=true;frame.hidden=false;report('loaded');},{once:true});
        frame.addEventListener('error',()=>report('error'),{once:true});
        // The provider alone runs remote code, in a scripts-only opaque frame.
        // It receives neither extension APIs nor the Peakbagger document origin.
        frame.src=`${url}embed/`;
    }catch{
        document.getElementById('status').textContent='This post could not be loaded.';
        report('error');
    }
})();
