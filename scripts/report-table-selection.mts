// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference types="chrome" />

/* global chrome, document, window */

import { waitForCondition } from './wait-for-condition.mts';

export interface RichTableSelectionTarget {
    tabId: number;
    cellIndex: number;
}

export interface RichTableSelectionState {
    nativeCell?: number;
    editorCell?: number;
    focused?: boolean;
    collapsed?: boolean;
    ready: boolean;
    error?: string;
}

export interface RichTableBridgePage {
    evaluate(
        fn: (arg: RichTableSelectionTarget) => Promise<RichTableSelectionState>,
        arg: RichTableSelectionTarget,
    ): Promise<RichTableSelectionState>;
}

export interface RichTableCellInput {
    bullets: (string | null)[];
    numbers: (string | null)[];
}

export interface RichTableInput {
    saved: string | undefined;
    cells: RichTableCellInput[];
}

export interface RichTablePage {
    evaluate(fn: () => RichTableInput): Promise<RichTableInput>;
}

export interface RichTableWaitOptions {
    description?: string;
    intervalMs?: number;
    timeoutMs?: number;
}

// A native cell click updates the DOM caret before selectionchange updates
// ProseMirror. Read the same isolated-world selection the toolbar consumes.
export async function readRichTableCellSelection({ tabId, cellIndex }: RichTableSelectionTarget): Promise<RichTableSelectionState> {
    interface RichEditorInstance {
        state: {
            selection: {
                empty: boolean;
                $from: {
                    depth: number;
                    node(depth: number): { type: { name: string } };
                    before(depth: number): number;
                };
            };
        };
        view: { nodeDOM(pos: number): unknown };
    }
    const [execution] = await chrome.scripting.executeScript<[number], RichTableSelectionState>({
        target: { tabId }, world: 'ISOLATED', args: [cellIndex],
        func: (index: number) => {
            const surface = document.querySelector('.bpb-re-surface') as (Element & { editor?: RichEditorInstance }) | null;
            const editor = surface?.editor;
            const cells = [...document.querySelectorAll('.bpb-re-surface td')];
            const selection = window.getSelection();
            const anchor = selection?.anchorNode;
            const anchorElement = anchor ? (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement) : null;
            const nativeCell = anchorElement?.closest('td') ?? null;
            const position = editor?.state.selection.$from;
            let editorCell: unknown = null;
            if (editor && position) {
                for (let depth = position.depth || 0; depth > 0; depth--) {
                    if (position.node(depth).type.name === 'tableCell') {
                        editorCell = editor.view.nodeDOM(position.before(depth));
                        break;
                    }
                }
            }
            const state = {
                nativeCell: nativeCell ? cells.indexOf(nativeCell) : -1,
                editorCell: (cells as unknown[]).indexOf(editorCell),
                focused: !!surface && document.activeElement === surface,
                collapsed: selection?.isCollapsed === true && editor?.state.selection.empty === true,
            };
            return {
                ...state,
                ready: state.nativeCell === index && state.editorCell === index
                    && state.focused && state.collapsed,
            };
        },
    });
    return execution?.result || { ready: false, error: 'No isolated editor selection result' };
}

export function waitForRichTableCellSelection(
    bridgePage: RichTableBridgePage | null | undefined,
    tabId: number | undefined,
    cellIndex: number,
    options: RichTableWaitOptions = {},
): Promise<RichTableSelectionState> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(cellIndex) || cellIndex < 0) {
        throw new TypeError('Rich table selection requires a tab ID and a nonnegative cell index');
    }
    if (!bridgePage) {
        throw new TypeError('Rich table selection requires a bridge page');
    }
    const targetTabId = tabId;
    return waitForCondition(() => bridgePage.evaluate(readRichTableCellSelection, { tabId: targetTabId, cellIndex }), {
        description: `the report caret and editor selection in cell ${cellIndex + 1}`,
        timeoutMs: 5000, ...options, isReady: state => state?.ready === true,
    });
}

export function readRichTableInput(): RichTableInput {
    return {
        saved: (document.getElementById('JournalText') as HTMLTextAreaElement | null)?.value,
        cells: [...document.querySelectorAll('.bpb-re-surface td')].map(cell => ({
            bullets: [...cell.querySelectorAll('ul > li')].map(item => item.textContent),
            numbers: [...cell.querySelectorAll('ol > li')].map(item => item.textContent),
        })),
    };
}

// Prove the fixture was actually typed before attributing later mismatches to
// Rich/Markdown conversion. A failed prerequisite must stop dependent edits.
export function waitForRichTableInput(
    page: RichTablePage,
    expected: RichTableInput,
    options: RichTableWaitOptions = {},
): Promise<RichTableInput> {
    return waitForCondition(() => page.evaluate(readRichTableInput), {
        description: 'the typed Rich table fixture before switching editor modes',
        timeoutMs: 5000, ...options,
        isReady: state => state?.saved === expected.saved
            && JSON.stringify(state.cells) === JSON.stringify(expected.cells),
    });
}
