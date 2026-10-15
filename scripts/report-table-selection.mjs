// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

/* global chrome, document, window */

import { waitForCondition } from './browser-verification-fixtures.mjs';

// A native cell click updates the DOM caret before selectionchange updates
// ProseMirror. Read the same isolated-world selection the toolbar consumes.
export async function readRichTableCellSelection({ tabId, cellIndex }) {
    const [execution] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'ISOLATED', args: [cellIndex],
        func: index => {
            const surface = document.querySelector('.bpb-re-surface');
            const editor = surface?.editor;
            const cells = [...document.querySelectorAll('.bpb-re-surface td')];
            const selection = window.getSelection();
            const anchor = selection?.anchorNode;
            const nativeCell = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest('td');
            const position = editor?.state.selection.$from;
            let editorCell = null;
            for (let depth = position?.depth || 0; depth > 0; depth--) {
                if (position.node(depth).type.name === 'tableCell') {
                    editorCell = editor.view.nodeDOM(position.before(depth));
                    break;
                }
            }
            const state = { nativeCell: cells.indexOf(nativeCell), editorCell: cells.indexOf(editorCell),
                focused: !!surface && document.activeElement === surface,
                collapsed: selection?.isCollapsed === true && editor?.state.selection.empty === true };
            return { ...state, ready: state.nativeCell === index && state.editorCell === index
                && state.focused && state.collapsed };
        },
    });
    return execution?.result || { ready: false, error: 'No isolated editor selection result' };
}

export function waitForRichTableCellSelection(bridgePage, tabId, cellIndex, options = {}) {
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(cellIndex) || cellIndex < 0) {
        throw new TypeError('Rich table selection requires a tab ID and a nonnegative cell index');
    }
    return waitForCondition(() => bridgePage.evaluate(readRichTableCellSelection, { tabId, cellIndex }), {
        description: `the report caret and editor selection in cell ${cellIndex + 1}`,
        timeoutMs: 5000, ...options, isReady: state => state?.ready === true,
    });
}
