// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reserve the actual wrapping of alternative readings without duplicating
// their text in the live region or imposing a clipped, fixed-height box.
export function createStableText(target) {
    const doc = target.ownerDocument;
    if (!doc.getElementById('bpb-sizing-text-style')) {
        const style = doc.createElement('style'); style.id = 'bpb-sizing-text-style';
        style.textContent = '.bpb-sizing-text > span{grid-area:1/1;min-width:0}'
            + '.bpb-sizing-text > [data-sizing-text]{visibility:hidden;pointer-events:none;user-select:none}'
            + '.bpb-sizing-text > [data-sizing-text]::after{content:attr(data-sizing-text)}';
        doc.head.append(style);
    }
    target.classList.add('bpb-sizing-text');
    target.style.display = 'grid';
    const label = doc.createElement('span'); label.textContent = target.textContent;
    target.replaceChildren(label);
    let signature;
    return {
        set: text => { label.textContent = text; },
        reserve: alternatives => {
            const labels = [...new Set(alternatives.filter(text => typeof text === 'string'))];
            const next = JSON.stringify(labels);
            if (next === signature) return;
            signature = next;
            target.replaceChildren(label, ...labels.map(text => {
                const sizing = doc.createElement('span'); sizing.dataset.sizingText = text;
                sizing.setAttribute('aria-hidden', 'true'); return sizing;
            }));
        },
    };
}
