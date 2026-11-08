// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ScriptInspection } from './report-script-source.ts';

export function createScriptNotice(doc: Document, inspection: ScriptInspection): HTMLDetailsElement | null {
    const {sources, limited} = inspection;
    if (!sources.length && !limited) return null;
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => {
        const element = doc.createElement(tag); element.className = className; element.textContent = text; return element;
    };
    const details = node('details', 'bpb-rs-notice');
    const summary = node('summary', 'bpb-rs-summary');
    summary.append(node('span', 'bpb-rs-context', 'Better Peakbagger report protection: '));
    const icon = node('span', 'bpb-rs-icon', '△'); icon.setAttribute('aria-hidden','true'); summary.append(icon);
    const title = !sources.length ? 'Script inspection limited' : limited ? 'Scripts blocked'
        : `${sources.length} script${sources.length === 1 ? '' : 's'} blocked`;
    summary.append(node('span', 'bpb-rs-title', title));
    const action = node('span','bpb-rs-action');
    action.append(node('span','bpb-rs-view',sources.length ? 'View code' : 'View details'),
        node('span','bpb-rs-hide',sources.length ? 'Hide code' : 'Hide details'));
    summary.append(action); details.append(summary);
    const panel = node('div','bpb-rs-panel');
    panel.append(node('p','bpb-rs-explanation', limited
        ? 'Inspection was limited by report size. Page scripts remain blocked; the sources below may be incomplete.'
        : 'Page scripts are disabled on trip reports, including harmless scripts.'));
    if (sources.length) {
        const choices = node('div','bpb-rs-choices');
        const pre = node('pre','bpb-rs-code'); pre.tabIndex = 0; pre.setAttribute('aria-label','Blocked source code');
        const code = node('code',''); pre.append(code);
        const labels = sources.map((source, index) => `${index + 1}. ${source.label}`);
        const buttons: HTMLButtonElement[] = [];
        const select = (index: number) => {
            const source = sources[index];
            // Original source is always text; it is never inserted as markup.
            code.textContent = source.code + (source.truncated ? '\n\n[Source truncated]' : '')
                + (source.external ? '\n\n[External file contents are not available. No file was fetched.]' : '');
            pre.scrollTop = 0; pre.scrollLeft = 0;
            buttons.forEach((button, position) => button.setAttribute('aria-pressed', String(position === index)));
        };
        if (sources.length <= 4) {
            sources.forEach((_, index) => {
                const button = node('button','bpb-rs-choice',labels[index]); button.type = 'button';
                button.addEventListener('click', () => select(index)); buttons.push(button); choices.append(button);
            });
        } else {
            const label = node('label','bpb-rs-select-label','Blocked source ');
            const picker = node('select','bpb-rs-select');
            labels.forEach((text, index) => { const option = node('option','',text); option.value = String(index); picker.append(option); });
            picker.addEventListener('change', () => select(picker.selectedIndex)); label.append(picker); choices.append(label);
        }
        select(0); panel.append(choices,pre);
        panel.append(node('p','bpb-rs-warning','Do not run this code or paste it into your browser console.'));
    }
    details.append(panel);
    return details;
}
