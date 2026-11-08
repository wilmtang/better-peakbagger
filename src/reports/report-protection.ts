// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { protectedReportDocument } from './report-security-policy.ts';
import { createInstagramPresentation } from './instagram-ui.js';
import { reportMarkup } from './report-markup.ts';
import { inspectReportScripts } from './report-script-source.ts';
import { createScriptNotice } from './report-script-notice.ts';

const processed = new WeakSet<Element>();
const extensionBrowser = (globalThis as typeof globalThis & {browser?: typeof chrome}).browser;
// getBrowserInfo is unavailable in Firefox content scripts. The trusted
// runtime URL identifies its origin without consulting page data or a UA.
const moduleWhitespace = ((extensionBrowser || globalThis.chrome)?.runtime?.getURL?.('') || '').startsWith('moz-extension:');
export function sanitizeReportCells(doc: Document): Set<HTMLElement> {
    const candidates = new Set<HTMLElement>();
    for (const heading of doc.querySelectorAll('h2,th')) {
        if (heading.textContent?.trim() !== 'Ascent Trip Report') continue;
        const cell = heading.closest('td') || heading.closest('tr')?.nextElementSibling?.lastElementChild;
        if (!cell || !cell.closest('table.gray') || !(cell instanceof doc.defaultView!.HTMLElement)) continue;
        candidates.add(cell);
    }
    // Nested report-like headings must not make us inspect our own rebuilt UI
    // or count the same source twice. DOM attributes cannot grant this trust.
    const cells = new Set([...candidates].filter(cell => !processed.has(cell)
        && ![...candidates].some(parent => parent !== cell && parent.contains(cell))));
    for (const cell of cells) {
        const inspection = inspectReportScripts(cell,{moduleWhitespace});
        // The response policy already blocks execution. Now remove active DOM,
        // handlers and clobbering attributes by rebuilding the existing AST.
        const source = reportMarkup.domToBracket(cell);
        const template = doc.createElement('template');
        template.innerHTML = reportMarkup.bracketToPreviewHtml(source);
        cell.replaceChildren(template.content);
        cell.dataset.bpbReportProtected = '';
        processed.add(cell);
        const notice = createScriptNotice(doc, inspection);
        if (notice) {
            const title = cell.querySelector('h2');
            if (title) title.after(notice); else cell.prepend(notice);
        }
    }
    return cells;
}

if (typeof document !== 'undefined' && protectedReportDocument(location.href)) {
    const mount = () => {
        const cells = sanitizeReportCells(document);
        if ((extensionBrowser || globalThis.chrome)?.runtime?.onMessage) {
            const instagram = createInstagramPresentation();
            for (const cell of cells) instagram.enhance(cell);
        }
        // The native header's only required inline behavior has a fixed packaged
        // replacement. Never evaluate or copy a handler supplied by the page.
        const input = document.getElementById('QuickSearchTB');
        const button = document.getElementById('QSButton');
        if (input instanceof HTMLInputElement && button instanceof HTMLInputElement
        && input.form?.name === 'Form1' && input.form === button.form
        && ![...cells].some(cell => cell.contains(input) || cell.contains(button))) {
            const search = () => {
                const url = new URL('/search.aspx', location.href);
                if (input.value.trim()) { url.searchParams.set('ss', input.value); url.searchParams.set('tid', 'M'); }
                location.assign(url.href);
            };
            input.removeAttribute('onkeypress'); button.removeAttribute('onclick');
            input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
            button.addEventListener('click', search);
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
    else mount();
}
