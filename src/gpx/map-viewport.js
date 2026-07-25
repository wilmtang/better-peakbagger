// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — the resizable wrapper around Peakbagger's MasterMap
// frame, extracted from src/gpx/gpx-analyzer.js.
//
// Owns exactly one thing: the map viewport's size, and everything that follows
// from changing it — the drag and keyboard resize affordances, the accessible
// label, the debounced persist, and telling Leaflet its container moved. It
// runs in the page's MAIN world alongside the analyzer, so it uses no extension
// APIs; the caller supplies the bounds (which belong to the settings schema,
// never a local copy) and the persist callback.

import { dom as Dom } from '../ui/dom.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

export const createMapViewport = ({
    iframe,
    size,
    bounds,
    railHeight,
    persistDelayMs,
    onPersist,
    onInvalidated = () => {},
} = {}) => {
    let current = {
        width: clamp(size.width, bounds.minWidth, bounds.maxWidth),
        height: clamp(size.height, bounds.minHeight, bounds.maxHeight),
    };
    let element = null;
    let handle = null;
    let invalidateFrame = null;
    let persistTimer = null;

    const renderedWidth = () => {
        if (!element) return current.width;
        const width = element.getBoundingClientRect().width;
        return width > 0 ? Math.round(width) : current.width;
    };

    const syncHandleLabel = () => {
        if (!handle) return;
        handle.setAttribute('aria-label', `Resize map. Current size ${renderedWidth()} pixels wide by ${current.height} pixels high. Use arrow keys for small steps.`);
    };

    const scheduleInvalidate = () => {
        if (!iframe || invalidateFrame !== null) return;
        const invalidate = () => {
            invalidateFrame = null;
            try {
                const map = iframe.contentWindow && iframe.contentWindow.mapsPlaceholder;
                if (map && typeof map.invalidateSize === 'function') map.invalidateSize(false);
            } catch (e) { /* Peakbagger may replace or discard its map while resizing. */ }
            // Re-anchor the floating toggle: the native zoom's position (2D)
            // and the viewport size can change as the map settles or resizes.
            onInvalidated();
        };
        invalidateFrame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(invalidate)
            : setTimeout(invalidate, 0);
    };

    const applySize = next => {
        current = {
            width: clamp(next.width, bounds.minWidth, bounds.maxWidth),
            height: clamp(next.height, bounds.minHeight, bounds.maxHeight),
        };
        if (!element) return;
        element.style.width = `${current.width}px`;
        element.style.height = `${current.height + railHeight}px`;
        syncHandleLabel();
        scheduleInvalidate();
    };

    const persist = () => {
        if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        onPersist({ width: current.width, height: current.height });
    };

    // Keyboard resize fires per key repeat; persisting each step would burn
    // through chrome.storage.sync's write-per-minute quota and the final size
    // could silently fail to stick. Persist once, shortly after the last
    // keystroke.
    const schedulePersist = () => {
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            persist();
        }, persistDelayMs);
    };

    if (iframe && iframe.parentElement) {
        element = Dom.element('div', {
            id: 'bpb-map-viewport',
            style: {
                position: 'relative',
                maxWidth: '100%',
                minWidth: 'min(320px, 100%)',
                minHeight: `${bounds.minHeight + railHeight}px`,
                maxHeight: `${bounds.maxHeight + railHeight}px`,
                boxSizing: 'border-box'
            }
        });

        iframe.before(element);
        element.append(iframe);
        Object.assign(iframe.style, {
            display: 'block',
            width: '100%',
            maxWidth: '100%',
            height: `calc(100% - ${railHeight}px)`,
            boxSizing: 'border-box'
        });

        handle = Dom.element('button', {
            id: 'bpb-map-resize-handle',
            type: 'button',
            title: 'Drag to resize map',
            text: '◢',
            style: {
                position: 'absolute',
                right: '0',
                bottom: '0',
                width: '24px',
                height: `${railHeight}px`,
                padding: '0',
                border: '0',
                background: 'transparent',
                color: 'currentColor',
                lineHeight: `${railHeight}px`,
                cursor: 'nwse-resize',
                opacity: '0.72'
            }
        });
        element.append(handle);

        let drag = null;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const parentRect = element.parentElement.getBoundingClientRect();
            const viewportRect = element.getBoundingClientRect();
            const parentWidth = parentRect.width;
            const viewportWidth = viewportRect.width;
            if (!(parentWidth > 0) || !(viewportWidth > 0)) return;
            const leftGap = viewportRect.left - parentRect.left;
            const rightGap = parentRect.right - viewportRect.right;
            drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startWidth: viewportWidth,
                startHeight: current.height,
                parentWidth,
                // Peakbagger centers its fixed-width map. In that layout a
                // 1 px pointer movement moves the right edge only 0.5 px
                // unless the requested width changes by 2 px.
                widthScale: Number.isFinite(leftGap) && Number.isFinite(rightGap) && Math.abs(leftGap - rightGap) <= 2 ? 2 : 1
            };
            if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const minWidth = Math.min(drag.parentWidth, bounds.minWidth);
            const widthPx = Math.min(bounds.maxWidth, drag.parentWidth, Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX) * drag.widthScale));
            applySize({
                width: widthPx,
                height: drag.startHeight + event.clientY - drag.startY
            });
        });
        const finishDrag = event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (handle.releasePointerCapture && handle.hasPointerCapture && handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            drag = null;
            persist();
        };
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('keydown', event => {
            const largeStep = event.shiftKey;
            const next = { ...current };
            if (event.key === 'ArrowLeft') next.width = renderedWidth() - (largeStep ? 50 : 10);
            else if (event.key === 'ArrowRight') next.width = renderedWidth() + (largeStep ? 50 : 10);
            else if (event.key === 'ArrowUp') next.height -= largeStep ? 50 : 10;
            else if (event.key === 'ArrowDown') next.height += largeStep ? 50 : 10;
            else return;
            event.preventDefault();
            applySize(next);
            schedulePersist();
        });

        applySize(current);
        window.addEventListener('resize', scheduleInvalidate);
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
            syncHandleLabel();
            scheduleInvalidate();
        }).observe(element);
    }

    return {
        get element() { return element; },
        get size() { return { ...current }; },
        applySize,
        scheduleInvalidate,
    };
};

export const mapViewport = { create: createMapViewport };
