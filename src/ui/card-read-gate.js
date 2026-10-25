// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read eligibility only. Callers retain request ownership, cached results and
// freshness policy; leaving the viewport never aborts an already-started read.
export function createCardReadGate({ card, enabled, active, collapsed = () => false, onChange = () => {} }) {
    const doc = card.ownerDocument, view = doc.defaultView;
    let disposed = false, observer = null, waitGeneration = 0;
    const eligible = () => !disposed && enabled() && active() && doc.visibilityState === 'visible'
        && !card.hidden && !collapsed() && card.dataset.bpbCardCollapsed !== 'true';
    let previous = eligible();
    const cancelWait = () => { waitGeneration++; observer?.disconnect(); observer = null; };
    const refresh = () => {
        if (disposed) return false;
        const next = eligible();
        if (!next) cancelWait();
        if (next === previous) return false;
        previous = next; onChange(next); return true;
    };
    const visibility = () => {
        // A visibility event also lets the caller check freshness. Ordinary
        // mutations/settings refreshes notify only on eligibility transitions.
        if (!refresh()) onChange(eligible());
    };
    const mutations = new view.MutationObserver(refresh);
    mutations.observe(card, { attributes: true, attributeFilter: ['hidden', 'data-bpb-card-collapsed'] });
    doc.addEventListener('visibilitychange', visibility);
    return {
        eligible, refresh, cancelWait,
        waitForViewport(onVisible) {
            if (!eligible() || observer) return;
            if (typeof view.IntersectionObserver !== 'function') { onVisible(); return; }
            const owner = ++waitGeneration;
            observer = new view.IntersectionObserver(entries => {
                if (owner !== waitGeneration || !eligible() || !entries.some(entry => entry.isIntersecting)) return;
                cancelWait(); onVisible();
            }, { rootMargin: '200px' });
            observer.observe(card);
        },
        dispose() {
            if (disposed) return;
            disposed = true; cancelWait(); mutations.disconnect(); doc.removeEventListener('visibilitychange', visibility);
        },
    };
}
