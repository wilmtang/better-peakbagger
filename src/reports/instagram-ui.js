// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalInstagramUrl, instagramParagraphUrl } from './instagram-url.js';
import { createStableText } from '../ui/stable-text.js';
import { createPageLifecycle } from '../ui/page-lifecycle.js';
import { trustedAction } from '../ui/trusted-action.js';
import { settings } from '../settings/settings.js';

const IDLE='Load this post to view it here. Connects to Instagram.';
const PENDING='Loading Instagram…';
const FAILED='Could not load this post. Try again or open it on Instagram.';
const NARROW='Open this post on Instagram, or widen this view to load it here.';
const LOADED='Loaded from Instagram.';
export function createInstagramPresentation({doc=document,ext=globalThis.browser||globalThis.chrome,preferences=settings,timeoutMs=20_000}={}) {
    const owner=doc.defaultView;
    const cards=new Set(), cardFor=new WeakMap(), activeLoads=new Set();
    let automatic=false,settingsRevision=0,sequence=0,disposed=false;
    const extensionUrl=new URL(ext.runtime.getURL(''));
    const extensionOrigin=`${extensionUrl.protocol}//${extensionUrl.host}`;
    const element=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
    const active=card=>{
        if(disposed||lifecycle.state!=='active'||!card.element.isConnected||!card.element.getClientRects().length)return false;
        for(let node=card.element;node;node=node.parentElement){const style=owner.getComputedStyle(node);if(node.hidden||style.display==='none'||style.visibility==='hidden')return false;}
        return true;
    };
    const handleSource=(message,sender,respond)=>{
        if(message?.type!=='INSTAGRAM_FRAME_SOURCE_CURRENT')return;
        respond({ok:sender.id===ext.runtime.id&&activeLoads.has(message.nonce)&&!disposed&&lifecycle.state==='active'});
    };
    ext.runtime.onMessage.addListener(handleSource);
    const lifecycle=createPageLifecycle({ownerWindow:owner,
        onSuspend:()=>cards.forEach(card=>card.stop(false)),onResume:()=>cards.forEach(card=>card.refresh()),
        onDispose:()=>dispose(),
    });
    const updatePreference=next=>{
        const value=next.loadInstagramAutomatically===true;
        if(value===automatic)return;
        automatic=value;
        for(const card of cards){card.stop(false);card.refresh();}
    };
    const unsubscribe=preferences.subscribe(next=>{settingsRevision++;updatePreference(next);});
    const initialRevision=settingsRevision;
    preferences.requireCurrent().then(next=>{if(!disposed&&initialRevision===settingsRevision)updatePreference(next);}).catch(()=>{});
    const visibility=new owner.MutationObserver(records=>{
        for(const card of [...cards]){
            if(!card.element.isConnected){card.destroy();continue;}
            if(records.some(record=>record.target.contains(card.element)))card.refresh();
        }
    });
    visibility.observe(doc,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style']});
    const intersections=owner.IntersectionObserver?new owner.IntersectionObserver(entries=>{
        for(const entry of entries){const card=cardFor.get(entry.target);if(card){card.onScreen=entry.isIntersecting;card.refresh();}}
    }):null;
    const resize=owner.ResizeObserver?new owner.ResizeObserver(entries=>{for(const entry of entries)cardFor.get(entry.target)?.refresh();}):null;

    function create(raw,{useLink}={}) {
        const url=canonicalInstagramUrl(raw);if(!url)throw new Error('Invalid Instagram post');
        const box=element('div','bpb-instagram');box.contentEditable='false';
        const title=element('p','bpb-instagram-title','Instagram post');
        const status=element('span','bpb-instagram-status',IDLE);status.setAttribute('role','status');
        const text=createStableText(status);text.reserve([IDLE,PENDING,FAILED,NARROW,LOADED]);
        const actions=element('div','bpb-instagram-actions');
        const button=element('button','bpb-instagram-action','Load Instagram post');button.type='button';button.dataset.bpbReportMediaUi='';
        const label=createStableText(button);label.reserve(['Load Instagram post','Cancel','Hide post','Retry']);
        const link=element('a','bpb-instagram-link','Open on Instagram');link.href=url;link.target='_blank';link.rel='noopener noreferrer';
        actions.append(button,link);
        if(useLink){const convert=element('button','bpb-instagram-as-link','Use link');convert.type='button';convert.dataset.bpbReportMediaUi='';convert.addEventListener('click',useLink);actions.append(convert);}
        const media=element('div','bpb-instagram-media');media.hidden=true;
        box.append(title,status,actions,media);
        let state='idle',generation=0,frame=null,timer=null,nonce=null,suppressed=false,dead=false;
        const clearTimer=()=>{if(timer!==null){owner.clearTimeout(timer);timer=null;}};
        const paint=()=>{
            label.set(state==='pending'?'Cancel':state==='loaded'?'Hide post':state==='error'?'Retry':'Load Instagram post');
            button.setAttribute('aria-label',state==='pending'?'Cancel loading Instagram post':state==='loaded'?'Hide Instagram post':state==='error'?'Retry loading Instagram post':'Load Instagram post');
            box.dataset.state=state;
        };
        const stop=(suppress=true)=>{
            generation++;activeLoads.delete(nonce);nonce=null;clearTimer();frame?.remove();frame=null;media.hidden=true;delete media.dataset.pending;
            state='idle';suppressed=suppress;text.set(IDLE);paint();
        };
        const fail=()=>{stop(true);state='error';text.set(FAILED);paint();};
        const load=async(event,auto=false)=>{
            if(dead||state==='pending'||state==='loaded'||!active(card)||(!auto&&event?.isTrusted!==true))return;
            if(box.clientWidth<320){text.set(NARROW);return;}
            suppressed=false;const revision=++generation;state='pending';text.set(PENDING);paint();
            const sourceNonce=owner.crypto.randomUUID();nonce=sourceNonce;activeLoads.add(sourceNonce);
            timer=owner.setTimeout(()=>{if(revision===generation)fail();},timeoutMs);
            try{
                const actionGeneration=`instagram-${++sequence}`;
                const activation=auto?null:await trustedAction.issue(ext,event,'instagram-post',actionGeneration);
                if(!auto&&!activation)throw new Error('activation');
                const response=await ext.runtime.sendMessage({type:'INSTAGRAM_FRAME_ISSUE',url,sourceNonce,automatic:auto,
                    ...(!auto&&{generation:actionGeneration,activationToken:activation.token})});
                if(dead||revision!==generation||!active(card))return;
                if(!response?.ok||!/^[a-f0-9]{48}$/.test(response.token))throw new Error('unavailable');
                frame=element('iframe','bpb-instagram-frame');frame.title='Instagram post';frame.referrerPolicy='no-referrer';frame.tabIndex=-1;
                frame.src=ext.runtime.getURL('reports/instagram.html')+'#'+response.token;
                media.dataset.pending='';media.hidden=false;media.append(frame);
            }catch{if(!dead&&revision===generation)fail();}
        };
        button.addEventListener('click',event=>{if(event.isTrusted!==true)return;if(state==='pending'||state==='loaded')stop();else void load(event);});
        const receive=event=>{
            if(!frame||event.source!==frame.contentWindow||event.origin!==extensionOrigin||state!=='pending')return;
            if(event.data?.__bpbInstagram==='error'){fail();return;}
            if(event.data?.__bpbInstagram!=='loaded')return;
            clearTimer();state='loaded';delete media.dataset.pending;frame.tabIndex=0;text.set(LOADED);paint();
        };
        owner.addEventListener('message',receive);
        const card={element:box,url,onScreen:!intersections,stop,
            refresh:()=>{
                if(dead)return;
                if(!active(card)){if(state==='pending'||state==='loaded')stop(false);return;}
                if(automatic&&card.onScreen&&!suppressed&&state==='idle')void load(null,true);
            },
            destroy:()=>{if(dead)return;dead=true;stop();owner.removeEventListener('message',receive);intersections?.unobserve(box);resize?.unobserve(box);cards.delete(card);cardFor.delete(box);},
        };
        cards.add(card);cardFor.set(box,card);intersections?.observe(box);resize?.observe(box);
        paint();
        owner.requestAnimationFrame?.(()=>card.refresh());
        return card;
    }

    function render(root,nodes) {
        const reusable=new Map();
        for(const child of root.children){const card=cardFor.get(child);if(card){const group=reusable.get(card.url)||[];group.push(card);reusable.set(card.url,group);}}
        const desired=[...nodes].map(node=>{
            const url=instagramParagraphUrl(node);if(!url)return node;
            return (reusable.get(url)?.shift()||create(url)).element;
        });
        for(const group of reusable.values())for(const card of group)card.destroy();
        // Remove obsolete prose first. An unchanged post then stays connected
        // even on Chrome versions without state-preserving moveBefore().
        const retained=new Set(desired);
        for(const node of [...root.childNodes])if(!retained.has(node))node.remove();
        let anchor=root.firstChild;
        for(const node of desired){
            if(node!==anchor){
                if(node.parentElement===root&&root.moveBefore&&node.isConnected)root.moveBefore(node,anchor);
                else{if(node.parentElement===root)cardFor.get(node)?.stop();root.insertBefore(node,anchor);}
            }
            anchor=node.nextSibling;
        }
        while(anchor){const next=anchor.nextSibling;anchor.remove();anchor=next;}
        for(const card of cards)if(root.contains(card.element))card.refresh();
    }
    function dispose(){
        if(disposed)return;disposed=true;unsubscribe();visibility.disconnect();intersections?.disconnect();resize?.disconnect();
        ext.runtime.onMessage.removeListener(handleSource);for(const card of [...cards])card.destroy();lifecycle.dispose();
    }
    return {create,render,enhance:root=>render(root,[...root.childNodes]),refresh:()=>cards.forEach(card=>card.refresh()),destroy:dispose};
}
