// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// This describes original report source, not whether code is malicious. The
// response CSP is the security boundary; inspection is bounded and read-only.
export interface BlockedSource { label: string; code: string; external: boolean; truncated: boolean }
export interface ScriptInspection { sources: BlockedSource[]; limited: boolean }
export const INSPECTION_LIMITS = Object.freeze({ nodes: 3000, attributes: 64, records: 64,
    itemChars: 8192, totalChars: 65536, srcdocChars: 32768, srcdocDepth: 3 });
const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const JS_TYPES = new Set(['application/ecmascript', 'application/javascript', 'application/x-ecmascript',
    'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript', ...Array.from({length:6}, (_, index) => `text/javascript1.${index}`)]);
const trimASCII = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');

function scriptKind(element: Element, moduleWhitespace: boolean): 'classic' | 'module' | 'limited' | null {
    if (element.namespaceURI !== HTML && element.namespaceURI !== SVG) return null;
    const explicit = element.getAttribute('type');
    const language = element.namespaceURI === HTML ? element.getAttribute('language') : null;
    if ((explicit?.length || 0) > 256 || (explicit === null && (language?.length || 0) > 256)) return 'limited';
    const type = (explicit === '' || (explicit === null && !language)) ? 'text/javascript'
        : explicit !== null ? trimASCII(explicit).toLowerCase() : `text/${language!.toLowerCase()}`;
    // Gecko also accepts whitespace-wrapped module values; Chromium does not.
    // The owner supplies this engine distinction from the isolated extension
    // API, never a report marker. Real browser fixtures pin both behaviors.
    if ((moduleWhitespace ? type : explicit?.toLowerCase()) === 'module') return 'module';
    if (!JS_TYPES.has(type)) return null;
    if (element.namespaceURI === HTML && element.hasAttribute('nomodule')) return null;
    if (element.namespaceURI === HTML && element.hasAttribute('for') && element.hasAttribute('event')) {
        const target = element.getAttribute('for')!, event = element.getAttribute('event')!;
        if (target.length > 256 || event.length > 256) return 'limited';
        if (trimASCII(target).toLowerCase() !== 'window' || !['onload','onload()'].includes(trimASCII(event).toLowerCase())) return null;
    }
    return 'classic';
}

// Inspect descriptors only. Reading an on* property can compile the handler,
// and page-supplied own properties / named form controls are not evidence.
function isEventAttribute(element: Element, name: string): boolean {
    if (!name.startsWith('on')) return false;
    for (let prototype = Object.getPrototypeOf(element); prototype; prototype = Object.getPrototypeOf(prototype)) {
        if (Object.getOwnPropertyDescriptor(prototype, name)) return true;
    }
    return false;
}

function navigates(element: Element, name: string): boolean {
    const tag = element.localName;
    if (element.namespaceURI === SVG) return tag === 'a' && (name === 'href' || (name === 'xlink:href' && !element.hasAttribute('href')));
    if (element.namespaceURI !== HTML) return false;
    if (name === 'href') return tag === 'a' || tag === 'area';
    if (name === 'src') return (tag === 'iframe' && !element.hasAttribute('srcdoc')) || tag === 'frame';
    if (name === 'action') return tag === 'form';
    if (name !== 'formaction' || !['input','button'].includes(tag)) return false;
    const rawType = element.getAttribute('type') || '';
    const type = rawType.length > 6 ? 'invalid' : rawType.toLowerCase();
    if (tag === 'input' ? !['submit','image'].includes(type) : ['button','reset'].includes(type)) return false;
    const form = element.hasAttribute('form') ? element.ownerDocument.getElementById(element.getAttribute('form')!) : element.closest('form');
    return form?.namespaceURI === HTML && form.localName === 'form';
}

export function inspectReportScripts(root: Element, {moduleWhitespace = false} = {}): ScriptInspection {
    const result: ScriptInspection = {sources:[], limited:false};
    let visited = 0, retained = 0, parsedChars = 0;
    const add = (label: string, raw: string, external = false, shortened = false) => {
        if (!raw.trim()) { if (shortened || raw.length > INSPECTION_LIMITS.itemChars) result.limited = true; return; }
        if (result.sources.length >= INSPECTION_LIMITS.records || retained >= INSPECTION_LIMITS.totalChars) {
            result.limited = true; return;
        }
        const limit = Math.min(INSPECTION_LIMITS.itemChars, INSPECTION_LIMITS.totalChars - retained);
        const truncated = shortened || raw.length > limit;
        const code = raw.slice(0, limit);
        retained += code.length;
        result.sources.push({label:label.slice(0,64),code,external,truncated});
    };
    const scriptText = (element: Element) => {
        let text = '', pieces = 0;
        for (let child = element.firstChild; child; child = child.nextSibling) {
            if (++pieces > INSPECTION_LIMITS.nodes) { result.limited = true; break; }
            if (child.nodeType !== 3 && child.nodeType !== 4) continue;
            const value = child.nodeValue || '';
            const room = INSPECTION_LIMITS.itemChars + 1 - text.length;
            text += value.slice(0, room);
            if (value.length > room || text.length > INSPECTION_LIMITS.itemChars) break;
        }
        return text;
    };
    const walk = (scope: Element | DocumentFragment, depth: number) => {
        let element: Element | null = scope.firstElementChild;
        while (element) {
            if (++visited > INSPECTION_LIMITS.nodes) { result.limited = true; return; }
            // Template contents and noscript text are inert in these browsers.
            // Real <script> descendants of PRE/CODE still execute; escaped
            // examples are text nodes and are naturally ignored here.
            const inert = element.namespaceURI === HTML && (element.localName === 'template' || element.localName === 'noscript');
            if (!inert) {
                const kind = element.localName === 'script' ? scriptKind(element,moduleWhitespace) : null;
                if (kind === 'limited') result.limited = true;
                if (kind && kind !== 'limited') {
                    const attribute = element.namespaceURI === HTML ? 'src'
                        : element.hasAttribute('href') ? 'href' : 'xlink:href';
                    const url = element.getAttribute(attribute);
                    if (url !== null) {
                        // Empty src ignores inline fallback and raises a load
                        // error. Never fetch an external file to inspect it.
                        if (trimASCII(url.slice(0, INSPECTION_LIMITS.itemChars + 1))) add('External script', `<script ${attribute}="${url.slice(0, INSPECTION_LIMITS.itemChars + 1)}"></script>`, true,
                            url.length > INSPECTION_LIMITS.itemChars);
                        else if (url.length > INSPECTION_LIMITS.itemChars) result.limited = true;
                    } else add('Inline script', scriptText(element));
                }
                let attributes = 0;
                for (const attribute of element.attributes) {
                    if (++attributes > INSPECTION_LIMITS.attributes) { result.limited = true; break; }
                    const event = attribute.name.length <= 64 && isEventAttribute(element, attribute.name);
                    const url = navigates(element, attribute.name);
                    if (!event && !url) continue;
                    const value = attribute.value.slice(0, INSPECTION_LIMITS.itemChars + 1);
                    const shortened = attribute.value.length > INSPECTION_LIMITS.itemChars;
                    if (!value.trim()) { if (shortened) result.limited = true; continue; }
                    const tag = element.localName.length > 24 ? 'element' : element.localName;
                    if (event) {
                        add(`${tag} ${attribute.name}`, `${attribute.name}="${value}"`, false,shortened);
                    } else if (url) {
                        if (shortened) result.limited = true;
                        try {
                            if (new URL(value, 'https://www.peakbagger.com/').protocol === 'javascript:') {
                                add(`${tag} ${attribute.name}`, value,false,shortened);
                            }
                        } catch { /* Invalid URLs are not executable JavaScript URLs. */ }
                    }
                }
                if (element.namespaceURI === HTML && element.localName === 'iframe' && element.hasAttribute('srcdoc')) {
                    const source = element.getAttribute('srcdoc')!;
                    if (depth >= INSPECTION_LIMITS.srcdocDepth || parsedChars + source.length > INSPECTION_LIMITS.srcdocChars) result.limited = true;
                    else {
                        parsedChars += source.length;
                        // Template parsing is detached, scripting-aware and
                        // resource-inert. Never insert this fragment into DOM.
                        const template = root.ownerDocument.createElement('template');
                        template.innerHTML = source;
                        walk(template.content, depth + 1);
                    }
                }
            }
            if (!inert && element.firstElementChild) { element = element.firstElementChild; continue; }
            while (element && element !== scope && !element.nextElementSibling) element = element.parentElement;
            if (!element || element === scope) break;
            element = element.nextElementSibling;
        }
    };
    walk(root, 0);
    return result;
}
