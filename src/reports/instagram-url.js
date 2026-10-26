// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export function canonicalInstagramUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const input = raw.trim();
    if (/[\s\\<>"'\u0000-\u001f]/.test(input)
        || !/^https:\/\/(?:www\.)?instagram\.com(?::443)?\//i.test(input)) return null;
    try {
        const url = new URL(input);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) return null;
        const rawPath = input.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
        if (url.pathname !== rawPath) return null;
        const path = /^\/(p|reel)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
        return path ? `https://www.instagram.com/${path[1]}/${path[2]}/` : null;
    } catch { return null; }
}

// A bounded tag/attribute scanner, not an HTML renderer or sanitizer. Nothing
// is attached to a DOM or fetched. Only a validated post identity survives.
export function instagramPasteUrl(raw) {
    const direct = canonicalInstagramUrl(raw);
    if (direct) return direct;
    if (typeof raw !== 'string' || raw.length > 65536) return null;
    const input = raw.trim();
    if (!/^<blockquote\b/i.test(input)) return null;
    let at = 0, depth = 0, blocks = 0, recognized = false;
    const posts = new Set();
    while (at < input.length) {
        if (input[at] !== '<') {
            const next = input.indexOf('<', at);
            const end = next < 0 ? input.length : next;
            if (!depth && input.slice(at,end).trim()) return null;
            at = end; continue;
        }
        const start = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)/i.exec(input.slice(at));
        if (!start) return null;
        const closing = !!start[1], tag = start[2].toLowerCase();
        at += start[0].length;
        const attrs = new Map();
        let ended = false;
        while (at < input.length) {
            while (/\s/.test(input[at] || '') && at < input.length) at++;
            if (input[at] === '>') {at++;ended=true;break;}
            if (input.slice(at,at+2) === '/>') {at+=2;ended=true;break;}
            const name = /^[a-z_:][a-z0-9_.:-]*/i.exec(input.slice(at));
            if (!name) return null;
            at += name[0].length;
            while (/\s/.test(input[at] || '') && at < input.length) at++;
            let value = '';
            if (input[at] === '=') {
                at++; while (/\s/.test(input[at] || '') && at < input.length) at++;
                const quote = input[at];
                if (quote === '"' || quote === "'") {
                    const end = input.indexOf(quote,++at); if (end < 0) return null;
                    value=input.slice(at,end);at=end+1;
                } else {
                    const unquoted=/^[^\s<>]+/.exec(input.slice(at));if(!unquoted)return null;
                    value=unquoted[0];at+=value.length;
                }
            }
            const key=name[0].toLowerCase();if(attrs.has(key))return null;attrs.set(key,value);
        }
        if (!ended) return null;
        if (tag === 'script' && !closing) {
            const end=/<\/script\s*>/ig;end.lastIndex=at;const close=end.exec(input);if(!close)return null;
            at=end.lastIndex;continue;
        }
        if (tag === 'blockquote') {
            depth += closing ? -1 : 1;
            if(depth<0||depth>1)return null;
            if(!closing){blocks++;const url=canonicalInstagramUrl(attrs.get('data-instgrm-permalink'));
                if(!url||!attrs.get('class')?.split(/\s+/).includes('instagram-media'))return null;
                recognized=true;posts.add(url);}
        } else if (!depth) return null;
        if(tag==='a'&&!closing){const url=canonicalInstagramUrl(attrs.get('href'));if(url)posts.add(url);}
    }
    return recognized && blocks===1 && depth===0 && posts.size===1 ? [...posts][0] : null;
}

// Peakbagger reports commonly display a post link as just its hostname. Keep
// those native labels equivalent to a full permalink, but leave custom captions
// (including Rich's "Instagram post" ordinary-link fallback) as ordinary links.
const instagramLinkUrl=(href,label)=>{
    const url=canonicalInstagramUrl(href),display=String(label??'').trim();
    return url&&(canonicalInstagramUrl(display)===url||/^(?:www\.)?instagram\.com$/i.test(display))?url:null;
};

export function instagramParagraphUrl(element) {
    if (element?.tagName !== 'P') return null;
    const nodes=[...element.childNodes].filter(node=>node.nodeType!==3||node.nodeValue.trim());
    if(nodes.length!==1)return null;
    const node=nodes[0];
    if(node.nodeType===3)return canonicalInstagramUrl(node.nodeValue);
    if(node.nodeName!=='A'||[...node.childNodes].some(child=>child.nodeType!==3))return null;
    return instagramLinkUrl(node.getAttribute('href'),node.textContent);
}

export function instagramBlocks(blocks) {
    return blocks.flatMap(block=>{
        if(block.type!=='p')return [block];
        const lines=[[]];for(const kid of block.kids){if(kid.t==='br')lines.push([]);else lines.at(-1).push(kid);}
        const urlFor=kids=>{
            if(kids.length===1&&kids[0].t==='text')return canonicalInstagramUrl(kids[0].text);
            if(kids.length!==1||kids[0].t!=='a'||kids[0].kids.some(kid=>kid.t!=='text'))return null;
            return instagramLinkUrl(kids[0].href,kids[0].kids.map(kid=>kid.text).join(''));
        };
        if(!lines.some(line=>urlFor(line)))return [block];
        const output=[];let pending=[];
        const flush=()=>{if(pending.length)output.push({type:'p',kids:pending});pending=[];};
        for(const line of lines){const url=urlFor(line);if(url){flush();output.push({type:'instagram',url});}
        else{if(pending.length)pending.push({t:'br'});pending.push(...line);}}
        flush();return output;
    });
}
