// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { protectedReportDocument } from './report-security-policy.js';
import { createInstagramPresentation } from './instagram-ui.js';
import { reportMarkup } from './report-markup.ts';

export function sanitizeReportCells(doc) {
    const cells = new Set();
    for (const heading of doc.querySelectorAll('h2,th')) {
        if (heading.textContent.trim() !== 'Ascent Trip Report') continue;
        const cell = heading.closest('td') || heading.closest('tr')?.nextElementSibling?.lastElementChild;
        if (!cell || !cell.closest('table.gray')) continue;
        cells.add(cell);
    }
    for (const cell of cells) {
        // The response policy already blocks execution. Now remove active DOM,
        // handlers and clobbering attributes by rebuilding the existing AST.
        const source = reportMarkup.domToBracket(cell);
        const parsed = new DOMParser().parseFromString(reportMarkup.bracketToPreviewHtml(source), 'text/html');
        cell.replaceChildren(...parsed.body.childNodes);
        cell.dataset.bpbReportProtected = '';
    }
    return cells;
}

if (typeof document !== 'undefined' && protectedReportDocument(location.href)) {
    const mount = () => {
        const cells = sanitizeReportCells(document);
        if ((globalThis.browser || globalThis.chrome)?.runtime?.onMessage) {
            const instagram = createInstagramPresentation();
            for (const cell of cells) instagram.enhance(cell);
        }
        // The native header's only required inline behavior has a fixed packaged
        // replacement. Never evaluate or copy a handler supplied by the page.
        const input = document.getElementById('QuickSearchTB');
        const button = document.getElementById('QSButton');
        if (input?.tagName === 'INPUT' && button?.tagName === 'INPUT'
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
