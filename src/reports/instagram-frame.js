// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl } from './instagram-url.js';
import { instagramEmbedHeight } from './instagram-sizing.js';
import { settings } from '../settings/settings.js';
const api=globalThis.browser||globalThis.chrome;
const token=location.hash.slice(1);
let parentOrigin='*';
const report=(state,height)=>parent.postMessage({__bpbInstagram:state,...(height!==null&&height!==undefined&&{height})},parentOrigin);
(async()=>{
    try{
        const response=await api.runtime.sendMessage({type:'INSTAGRAM_FRAME_CLAIM',token});
        const url=response?.ok&&canonicalInstagramUrl(response.url);
        if(!url||!response.parentOrigin)throw new Error('unavailable');
        const providerOrigin=new URL(url).origin;
        parentOrigin=response.parentOrigin;
        const frame=document.getElementById('post');
        const scheme=matchMedia('(prefers-color-scheme: dark)');
        let displayRevision=0,themeRevision=0,preference='system',disposed=false;
        const configureDisplay=async()=>{
            const revision=++displayRevision;
            let enabled=false;
            try{const reply=await api.runtime.sendMessage({type:'INSTAGRAM_DISPLAY_STATE'});enabled=reply?.ok===true&&reply.allowed===true;}catch{/* Native display is still usable. */}
            if(disposed||revision!==displayRevision)return;
            frame.contentWindow.postMessage({__bpbInstagramDisplay:true,enabled,theme:settings.resolveTheme(preference)},providerOrigin);
        };
        const changed=()=>{void configureDisplay();};
        scheme.addEventListener('change',changed);
        const unsubscribe=settings.subscribe(next=>{themeRevision++;preference=next.theme;changed();});
        const initialThemeRevision=themeRevision;
        void settings.requireCurrent().then(next=>{if(!disposed&&initialThemeRevision===themeRevision){preference=next.theme;changed();}}).catch(()=>{});
        const displayChanged=(message,sender)=>{if(sender?.id===api.runtime.id&&message?.type==='INSTAGRAM_DISPLAY_CHANGED')changed();};
        api.runtime.onMessage?.addListener(displayChanged);
        addEventListener('pagehide',()=>{disposed=true;displayRevision++;unsubscribe();scheme.removeEventListener('change',changed);
            api.runtime.onMessage?.removeListener(displayChanged);},{once:true});
        let height=null,reported=false,complete=false,fallback=null;
        const finish=(allowFallback=false)=>{
            if(reported||!complete||(height===null&&!allowFallback))return;
            reported=true;clearTimeout(fallback);document.getElementById('status').hidden=true;report('loaded',height);
        };
        addEventListener('message',event=>{
            // Require both the canonical provider origin and the actual child
            // WindowProxy; another Instagram window cannot resize this post.
            if(event.source!==frame.contentWindow||event.origin!==providerOrigin)return;
            if(event.data?.__bpbInstagramProvider==='ready'){void configureDisplay();return;}
            if(reported||typeof event.data!=='string'||event.data.length>2048)return;
            try{
                const message=JSON.parse(event.data);
                if(message?.type==='MEASURE'){
                    height=instagramEmbedHeight(message.details?.height)??height;finish();
                }
            }catch{ /* Unknown provider messages never affect layout. */ }
        });
        frame.addEventListener('load',async()=>{
            // Complete as soon as the loaded provider has measured its caption.
            // A missing/changed provider protocol falls back once to scrolling;
            // later measurements never bounce the report.
            // The helper's document-start ready message may precede listener
            // delivery in some browsers. Always configure the loaded child too.
            await configureDisplay();if(disposed)return;
            complete=true;finish();
            if(!reported)fallback=setTimeout(()=>finish(true),1000);
        },{once:true});
        frame.addEventListener('error',()=>report('error'),{once:true});
        // Retain Instagram's own origin so its lazy video-loader requests stay
        // same-origin. The cross-origin provider cannot access this packaged
        // wrapper or Peakbagger, or remove its sandbox. CSP pins frame navigation
        // to Instagram; popups, forms and top navigation remain sandboxed.
        // Give the provider its real width while the parent is still hidden,
        // so its caption-inclusive height is measured at the intended size.
        frame.hidden=false;
        frame.src=`${url}embed/captioned/`;
    }catch{
        document.getElementById('status').textContent='This post could not be loaded.';
        report('error');
    }
})();
