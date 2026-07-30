// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sidebar section navigation. Native anchors already scroll and deep-link;
// this only tracks which link is the active one. The whole feature is inert
// if the sidebar markup is absent, so options.js keeps working without it.
export const initSectionNav = () => {
    const nav = document.querySelector('.side-nav');
    const content = document.querySelector('.content');
    if (!nav || !content) return;
    // Level-1 links and always-visible level-2 links, in document order. A
    // sub-item's section is its subsection div, which follows its parent
    // section's heading in the DOM, so the last-top-≤-marker scan below
    // activates sub-items with no extra ordering logic. Each sub-item also
    // remembers its parent nav-item so the parent can be highlighted.
    const entries = Array.from(nav.querySelectorAll('a.nav-item, a.nav-subitem'))
        .map(link => {
            const section = link.hash ? document.getElementById(link.hash.slice(1)) : null;
            if (!section) return null;
            const sublist = link.closest('.nav-sublist');
            const parentLink = sublist ? sublist.closest('li').querySelector(':scope > a.nav-item') : null;
            return { link, section, parentLink };
        })
        .filter(Boolean);
    if (!entries.length) return;

    // Initial fragment navigation happens after this script runs. Override
    // the pane's CSS smooth behavior until that one native landing finishes;
    // otherwise a newly opened deep link visibly travels down the page.
    let initialScrollOverride = false;
    let initialScrollTarget = null;
    let distanceScrollRevision = 0;
    const finishInitialScroll = alignTarget => {
        if (!initialScrollOverride) return;
        initialScrollOverride = false;
        if (alignTarget && initialScrollTarget) {
            // Narrow layouts put the content scroller below the horizontal
            // nav. Chromium's initial fragment landing can account for that
            // offset twice, so normalize against the actual scroll container.
            const margin = parseFloat(getComputedStyle(initialScrollTarget).scrollMarginTop) || 0;
            const delta = initialScrollTarget.getBoundingClientRect().top
                - content.getBoundingClientRect().top - margin;
            if (Math.abs(delta) > 1) content.scrollTop += delta;
        }
        initialScrollTarget = null;
        content.style.removeProperty('scroll-behavior');
    };

    // Smooth motion helps readers keep their place over a nearby jump, but
    // becomes a delay when a dynamic section is thousands of pixels tall.
    // Keep native anchor/history behavior and override only the animation
    // for long jumps. The pixel cap also keeps a tall viewport from turning
    // a nominally "nearby" jump into a lengthy animation.
    const MAX_SMOOTH_SCROLL_VIEWPORTS = 2;
    const MAX_SMOOTH_SCROLL_PX = 1200;
    const scrollDistanceTo = section => {
        const margin = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
        return Math.abs(section.getBoundingClientRect().top
            - content.getBoundingClientRect().top - margin);
    };
    const prepareAnchorScroll = section => {
        const revision = ++distanceScrollRevision;
        content.style.removeProperty('scroll-behavior');

        const viewportHeight = content.clientHeight;
        if (!(viewportHeight > 0)) return;
        const smoothLimit = Math.min(
            viewportHeight * MAX_SMOOTH_SCROLL_VIEWPORTS,
            MAX_SMOOTH_SCROLL_PX
        );
        if (scrollDistanceTo(section) <= smoothLimit) return;

        // Chromium performs fragment scrolling during the click's default
        // action; Firefox defers nested-scroller movement until rendering.
        // Span two frames so both see the override, using a timer only in
        // non-visual test environments without requestAnimationFrame.
        content.style.scrollBehavior = 'auto';
        const restore = () => {
            if (revision === distanceScrollRevision) content.style.removeProperty('scroll-behavior');
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(restore));
        } else setTimeout(restore, 0);
    };

    const setActive = active => {
        const activeParent = (entries.find(entry => entry.link === active) || {}).parentLink || null;
        for (const { link } of entries) {
            if (link === active) link.setAttribute('aria-current', 'true');
            else link.removeAttribute('aria-current');
            // The parent of the active sub-item gets the accent (unfilled)
            // treatment; every other link clears it.
            link.classList.toggle('nav-parent-active', link === activeParent);
        }
    };

    // Which link matches the current scroll position: the last section whose
    // top has scrolled up past a marker just below the content's top edge
    // (viewport-relative rects sidestep offsetParent assumptions). A bottom
    // clamp lets a short final section win once the scroll bottoms out.
    const ACTIVATE_MARGIN = 40;
    const activeFromScroll = () => {
        if (content.scrollHeight > content.clientHeight
            && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) {
            return entries[entries.length - 1].link;
        }
        const marker = content.getBoundingClientRect().top + ACTIVATE_MARGIN;
        let active = entries[0].link;
        for (const { link, section } of entries) {
            if (section.getBoundingClientRect().top <= marker) active = link;
            else break;
        }
        return active;
    };

    // Nav lock: a click or hashchange pins the target active and suppresses
    // the scroll-spy so the highlight can't sweep through intermediate
    // sections during the smooth scroll. Release on scrollend, or after a
    // short period with no scroll events for browsers that omit scrollend.
    // Do not recompute on release: a near-bottom target can be fully visible
    // without reaching the marker, but the explicit deep link still wins.
    let navLocked = false;
    let navLockTimer = null;
    const armIdleRelease = () => {
        clearTimeout(navLockTimer);
        navLockTimer = setTimeout(() => { navLocked = false; }, 250);
    };
    const lockTo = link => {
        setActive(link);
        navLocked = true;
        armIdleRelease();
        link.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };

    content.addEventListener('scroll', () => {
        if (navLocked) armIdleRelease();
        else setActive(activeFromScroll());
    }, { passive: true });
    content.addEventListener('scrollend', () => {
        clearTimeout(navLockTimer);
        navLocked = false;
        finishInitialScroll(true);
    });
    for (const { link, section } of entries) {
        link.addEventListener('click', event => {
            // Modified clicks belong to the browser (for example, opening a
            // deep link in a new tab) and must not move this settings page.
            if (event.defaultPrevented || event.button !== 0
                || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            finishInitialScroll(false);
            prepareAnchorScroll(section);
            lockTo(link);
        });
    }
    window.addEventListener('hashchange', () => {
        finishInitialScroll(false);
        const target = entries.find(entry => entry.link.hash === location.hash);
        if (target) lockTo(target.link);
    });

    // Initial state: honor a deep-link hash, otherwise the first section.
    const initial = entries.find(entry => entry.link.hash === location.hash);
    if (initial) {
        initialScrollOverride = true;
        initialScrollTarget = initial.section;
        content.style.scrollBehavior = 'auto';
        lockTo(initial.link);
    }
    else setActive(entries[0].link);
};

