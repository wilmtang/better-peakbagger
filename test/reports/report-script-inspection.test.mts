// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../helpers/test-dom.mts';
import { marked } from 'marked';
import { inspectReportScripts, INSPECTION_LIMITS } from '../../src/reports/report-script-source.ts';
import { createScriptNotice } from '../../src/reports/report-script-notice.ts';
import { sanitizeReportCells } from '../../src/reports/report-protection.ts';
import { reportMarkup } from '../../src/reports/report-markup.ts';

function fixture(source: string) {
    const dom = new JSDOM('<!doctype html><body><main></main>', {runScripts:'outside-only',url:'https://www.peakbagger.com/climber/ascent.aspx'});
    const root = dom.window.document.querySelector('main')!;
    globalThis.DOMParser = dom.window.DOMParser;
    root.innerHTML = source;
    return {dom,root};
}
test('inert foreign-namespace names do not masquerade as HTML scripts or frames', () => {
    const {dom,root} = fixture('<math><script>data()</script><iframe srcdoc="&lt;script&gt;data()&lt;/script&gt;"></iframe>'
        + '<a href="javascript:data()">Data</a></math>'
        + '<svg><script type="module">unsupported()</script><script language="vbscript">svgClassic()</script></svg>');
    try {
        const inspection = inspectReportScripts(root);
        assert.equal(inspection.sources.length,2);
        assert.equal(inspection.sources[0].code,'unsupported()');
        assert.equal(inspection.sources[1].code,'svgClassic()');
    } finally {dom.window.close();}
});
test('quoted examples, data, inert scripts and non-JavaScript sanitizer removals do not create alarms', () => {
    const {dom,root} = fixture('<pre><code>&lt;script&gt;example()&lt;/script&gt;</code></pre>'
        + '<figure><figcaption>onclick="example()"</figcaption></figure>'
        + '<script type="application/json">{"x":1}</script><script type="text/plain">example()</script>'
        + '<script type="importmap">{"imports":{}}</script><script nomodule>legacy()</script>'
        + '<script type="application/json" language="javascript">example()</script>'
        + '<script src="">ignoredBody()</script><script src="  ">ignoredBody()</script><script> \n </script>'
        + '<img onerror=" " onward="example()" src="javascript:example()">'
        + '<div href="javascript:example()">Prose</div><a href="java script:example()">Inert URL</a>'
        + '<style>p{color:red}</style><audio controls></audio><form><button>Submit</button></form>'
        + '<iframe src="https://example.com/player"></iframe><video><source src="/movie.mp4"></video>'
        + '<template><script>templateOnly()</script></template>');
    try {
        const inspection = inspectReportScripts(root);
        assert.deepEqual(inspection,{sources:[],limited:false});
        assert.equal(createScriptNotice(dom.window.document,inspection),null);
        const img = root.querySelector('img')!;
        img.onerror = () => {};
        root.querySelector('a')!.addEventListener('click', () => {});
        assert.equal(inspectReportScripts(root).sources.length,0,'property/listener callbacks are not saved report source');
    } finally {dom.window.close();}
});
test('original executable types, supported handlers and navigable JavaScript URLs are described without trusting BPB markers', () => {
    const {dom,root} = fixture('<script data-bpb-trusted="true">classic()</script><script type="module" nomodule>moduleCode()</script>'
        + '<script language="javascript">legacy()</script><script type="text/javascript1.5">oldMime()</script>'
        + '<script type="" language="nonsense">typeWins()</script>'
        + '<pre><code><script>realScriptInPre()</script></code></pre>'
        + '<img src="/x" onerror="imageError()"><svg onload="svgLoad()"></svg>'
        + '<a href="java&#10;script:linkCode()">Link</a><form action="javascript:formCode()"></form>'
        + '<script src="/external.js">ignoredExternalFallback()</script>');
    try {
        Object.defineProperty(root.querySelector('img'),'onerror',{get() {throw new Error('Must not compile handlers');}});
        const inspection = inspectReportScripts(root);
        assert.equal(inspection.sources.length,11);
        assert.equal(inspection.limited,false);
        assert.match(inspection.sources.map(source => source.code).join('\n'),/realScriptInPre/);
        assert.doesNotMatch(inspection.sources.map(source => source.code).join('\n'),/ignoredExternalFallback/);
        assert.deepEqual(inspection.sources.at(-1),{label:'External script',code:'<script src="/external.js"></script>',external:true,truncated:false});
    } finally {dom.window.close();}
});
test('srcdoc inspection is detached, recursive and single-decoded; template and noscript contents remain inert', () => {
    const {dom,root} = fixture('');
    try {
        const frame = dom.window.document.createElement('iframe');
        frame.setAttribute('srcdoc','<script>frameCode()</script><iframe srcdoc="&lt;img onerror=&quot;nested()&quot;&gt;"></iframe>'
            + '<template><script>inertTemplate()</script></template><noscript><script>inertFallback()</script></noscript>'
            + '&lt;script&gt;quotedFrameExample()&lt;/script&gt;<img src="https://example.com/inert.png">');
        root.append(frame);
        const inspection = inspectReportScripts(root);
        assert.equal(inspection.sources.length,2);
        assert.match(inspection.sources[0].code,/frameCode/);
        assert.match(inspection.sources[1].code,/nested/);
        assert.equal(inspection.limited,false);
        assert.equal(root.querySelectorAll('script').length,0,'parsed frame contents are never inserted');
    } finally {dom.window.close();}
});
test('inspection limits retain honest partial states and bounded source text', () => {
    const {dom,root} = fixture('<script>'+'x'.repeat(INSPECTION_LIMITS.itemChars+10)+'</script>');
    try {
        let inspection = inspectReportScripts(root);
        assert.equal(inspection.sources[0].code.length,INSPECTION_LIMITS.itemChars);
        assert.equal(inspection.sources[0].truncated,true);
        assert.equal(inspection.limited,false,'one truncated source does not imply an unknown count');
        root.innerHTML = '<script>x()</script>'.repeat(INSPECTION_LIMITS.records+1);
        inspection = inspectReportScripts(root);
        assert.equal(inspection.sources.length,INSPECTION_LIMITS.records); assert(inspection.limited);
        const notice = createScriptNotice(dom.window.document,inspection)!;
        assert.equal(notice.querySelector('.bpb-rs-title')!.textContent,'Scripts blocked');
        assert.equal(notice.querySelectorAll('select option').length,INSPECTION_LIMITS.records);
        root.innerHTML = '<span></span>'.repeat(INSPECTION_LIMITS.nodes+1)+'<script>notReached()</script>';
        inspection = inspectReportScripts(root);
        assert.deepEqual(inspection,{sources:[],limited:true});
        assert.match(createScriptNotice(dom.window.document,inspection)!.textContent!,/Script inspection limited/);
        root.innerHTML = '<iframe></iframe>';
        root.firstElementChild!.setAttribute('srcdoc','x'.repeat(INSPECTION_LIMITS.srcdocChars+1));
        assert.deepEqual(inspectReportScripts(root),{sources:[],limited:true});
        root.innerHTML = ('<script>'+'x'.repeat(INSPECTION_LIMITS.itemChars)+'</script>').repeat(20);
        inspection = inspectReportScripts(root);
        assert(inspection.limited);
        assert(inspection.sources.reduce((sum, source) => sum + source.code.length,0) <= INSPECTION_LIMITS.totalChars);
    } finally {dom.window.close();}
});
test('notice uses inert text and native disclosure; source selection preserves controls and focus', () => {
    const {dom,root} = fixture('');
    try {
        const notice = createScriptNotice(dom.window.document,{limited:false,sources:[
            {label:'Inline script',code:'</code></pre><img onerror="run()">',truncated:false,external:false},
            {label:'External script',code:'<script src="/safe.js"></script>',truncated:false,external:true},
        ]})!;
        root.append(notice);
        assert.equal(notice.open,false);
        assert.equal(notice.querySelector('img,script'),null);
        assert.equal(notice.querySelector('summary')!.hasAttribute('aria-label'),false);
        assert.match(notice.querySelector('summary')!.textContent!,/Better Peakbagger report protection: .*2 scripts blocked/);
        const buttons = [...notice.querySelectorAll('button')];
        buttons[1].focus(); buttons[1].click();
        assert.equal(dom.window.document.activeElement,buttons[1]);
        assert.equal(buttons[1].getAttribute('aria-pressed'),'true');
        assert.equal(buttons[0].getAttribute('aria-pressed'),'false');
        assert.match(notice.querySelector('pre')!.textContent!,/External file contents are not available/);
        assert.match(notice.textContent!,/including harmless scripts/);
        assert.match(notice.textContent!,/Do not run this code/);
    } finally {dom.window.close();}
});
test('author-controlled tag labels and attribute classification work stay bounded', () => {
    const {dom,root} = fixture('<x-'+'a'.repeat(20000)+' onclick="example()"></x-'+'a'.repeat(20000)+'>');
    try {
        assert.equal(inspectReportScripts(root).sources[0].label,'element onclick');
        root.innerHTML = '<a></a>';
        root.firstElementChild!.setAttribute('href',' '.repeat(20000)+'javascript:late()');
        let inspection = inspectReportScripts(root);
        assert.deepEqual(inspection,{sources:[],limited:true});
        assert.match(createScriptNotice(dom.window.document,inspection)!.textContent!,/View details/);
        root.innerHTML = '<img>';
        root.firstElementChild!.setAttribute('data-harmless','x'.repeat(20000));
        root.firstElementChild!.setAttribute('onerror',' '.repeat(20000)+'late()');
        inspection = inspectReportScripts(root);
        assert.deepEqual(inspection,{sources:[],limited:true});
        root.innerHTML = '<script>'+' '.repeat(9000)+'blocked()</script>';
        assert.deepEqual(inspectReportScripts(root),{sources:[],limited:true},'a capped whitespace prefix cannot hide blocked source');
    } finally {dom.window.close();}
});
test('unsupported classic legacy script event pairs are inert', () => {
    const {dom,root} = fixture('<script for="other" event="onclick">ignored()</script><script for="window" event="onscroll">ignored()</script>'
        + '<script for=" window " event=" onload() ">classic()</script><script type="module" for="other" event="onclick">moduleCode()</script>');
    try { assert.equal(inspectReportScripts(root).sources.length,2); } finally {dom.window.close();}
});
test('URL inspection respects native href, frame source and submit-control precedence', () => {
    const {dom,root} = fixture('<a xlink:href="javascript:ignored()">HTML</a>'
        + '<svg><a href="https://example.com" xlink:href="javascript:ignored()">SVG</a></svg>'
        + '<iframe src="javascript:ignored()" srcdoc="Safe text"></iframe>'
        + '<form><input formaction="javascript:ignored()"><button type="button" formaction="javascript:ignored()">Button</button>'
        + '<input type="reset" formaction="javascript:ignored()"><input type="submit" formaction="javascript:actual()"></form>'
        + '<button formaction="javascript:ignored()">No form owner</button>');
    try {
        const inspection = inspectReportScripts(root);
        assert.equal(inspection.sources.length,1); assert.equal(inspection.sources[0].code,'javascript:actual()');
    } finally {dom.window.close();}
});
test('module whitespace follows the owning browser rather than a report attribute', () => {
    const {dom,root} = fixture('<script type=" module " data-bpb-browser="firefox">wrapped()</script>'
        + '<svg><script type=" module ">svgWrapped()</script></svg>');
    try {
        assert.equal(inspectReportScripts(root).sources.length,0);
        assert.equal(inspectReportScripts(root,{moduleWhitespace:true}).sources.length,2);
    } finally {dom.window.close();}
});
test('a non-ASCII space in external src is a resource path, not an empty script', () => {
    const {dom,root} = fixture('<script src="&#160;"></script>');
    try { assert.equal(inspectReportScripts(root).sources.length,1); } finally {dom.window.close();}
});
test('overlapping roots and repeated sanitization cannot double count source or resanitize the inspector', () => {
    const {dom,root} = fixture('<table class="gray"><tr><td data-bpb-report-protected><h2>Ascent Trip Report</h2>'
        + '<table class="gray"><tr><td><h2>Ascent Trip Report</h2><script>original()</script></td></tr></table>'
        + '</td></tr></table><script>nativeOutsideReport()</script>');
    try {
        const cells = sanitizeReportCells(dom.window.document);
        assert.equal(cells.size,1);
        assert.equal(root.querySelectorAll('.bpb-rs-notice').length,1);
        const notice = root.querySelector('.bpb-rs-notice')!;
        assert.match(notice.textContent!,/1 script blocked/);
        assert.doesNotMatch(notice.textContent!,/nativeOutsideReport/);
        assert.equal(sanitizeReportCells(dom.window.document).size,0);
        assert.equal(root.querySelector('.bpb-rs-notice'),notice);
    } finally {dom.window.close();}
});
test('BPB rich and Markdown output remains script-free, while raw Plain JavaScript is still blocked', () => {
    const {dom,root} = fixture('');
    try {
        Object.assign(globalThis,{marked});
        for (const html of [reportMarkup.bracketToPreviewHtml('[b]Report[/b]\n[img alt="Summit"]https://example.com/p.jpg[/img]'),
            reportMarkup.markdownToPreviewHtml('## Report\n\nA [safe link](https://example.com) and `onclick="example()"`\n\n```html\n<script>quoted()</script>\n```')]) {
            root.innerHTML = html;
            assert.deepEqual(inspectReportScripts(root),{sources:[],limited:false});
        }
        root.innerHTML = '<script>harmlessPlainMode()</script>';
        assert.equal(inspectReportScripts(root).sources.length,1);
    } finally {dom.window.close();}
});
