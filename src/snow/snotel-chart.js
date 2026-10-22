// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// The caption doubles as the readout. Inspecting a point never inserts a row
// or changes the plot's scale; missing days remain gaps, including under focus.
export function createSnotelChart({ frame, graph, empty, maximum, zero, ticks, caption, dateLabel, depthText }) {
    const doc = frame.ownerDocument, win = doc.defaultView;
    const hint = 'Snow depth · Hover, tap or use ← →';
    caption.reserve([hint, 'Daily snow depth unavailable', 'Sep 30 · Snow depth unavailable',
        'Sep 30 · Snow depth 3810.0 cm', 'Sep 30 · Snow depth 1500.0 in']);
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', 'Daily snow depth. NRCS end-of-day dates. Use Left and Right, Home and End for readings; Escape to clear.');
    const readout = doc.createElement('span');
    readout.className = 'bpb-snow-chart-status'; readout.setAttribute('role', 'status'); readout.setAttribute('aria-atomic', 'true');
    frame.append(readout);
    let station = null, dates = [], values = [], loaded = false, enabled = false, disposed = false;
    let pinned = null, hover = null, width = 320, height = 80;
    const available = () => values.some(value => value !== null);
    const svg = (tag, attributes) => {
        const node = doc.createElementNS(graph.namespaceURI, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
    };
    const xAt = index => 8 + index * (width - 16) / Math.max(1, dates.length - 1);
    const maxValue = () => Math.max(1, ...values.filter(value => value !== null));
    const yAt = value => height * (.85 - value / maxValue() * .55);
    const selectedText = index => `${dateLabel(dates[index])} · Snow depth ${values[index] === null ? 'unavailable' : depthText(values[index])}`;
    const showSelection = (announce = false) => {
        graph.querySelectorAll('.bpb-snow-cursor, .bpb-snow-selected').forEach(node => node.remove());
        const index = hover ?? dates.indexOf(pinned);
        const selected = enabled && available() && index >= 0 && index < dates.length;
        const text = selected ? selectedText(index) : available() ? hint : loaded ? 'Daily snow depth unavailable' : 'Daily snow-depth trend';
        caption.set(text);
        if (announce) readout.textContent = selected ? text : 'Selection cleared.';
        if (!selected) return;
        const x = xAt(index);
        graph.append(svg('path', { d: `M${x},${height * .17}V${height * .9}`, class: 'bpb-snow-cursor' }));
        if (values[index] !== null) graph.append(svg('circle', { cx: x, cy: yAt(values[index]), r: 4, class: 'bpb-snow-selected' }));
    };
    const draw = () => {
        const bounds = graph.getBoundingClientRect();
        width = Math.max(32, bounds.width || 320); height = Math.max(32, bounds.height || 80);
        graph.setAttribute('viewBox', `0 0 ${width} ${height}`);
        graph.replaceChildren();
        const hasReadings = available();
        frame.tabIndex = enabled && hasReadings ? 0 : -1;
        frame.classList.toggle('bpb-snow-interactive', enabled && hasReadings);
        empty.hidden = hasReadings; maximum.hidden = zero.hidden = !hasReadings;
        maximum.textContent = depthText(Math.max(0, ...values.filter(value => value !== null)));
        empty.textContent = loaded ? 'No daily snow-depth readings' : 'Daily snow-depth trend';
        ticks.forEach(tick => { tick.textContent = loaded ? dateLabel(dates[Number(tick.dataset.day)]) : ''; });
        if (hasReadings) {
            graph.append(svg('path', { d: `M8,${height * .85}H${width - 8}`, class: 'bpb-snow-baseline' }));
            let path = '', connected = false;
            values.forEach((value, index) => {
                if (value === null) { connected = false; return; }
                path += `${connected ? 'L' : 'M'}${xAt(index)},${yAt(value)}`; connected = true;
            });
            graph.append(svg('path', { d: path }));
            values.forEach((value, index) => {
                if (value === null) return;
                const dot = svg('circle', { cx: xAt(index), cy: yAt(value), r: 2 });
                const title = svg('title', {}); title.textContent = `${dateLabel(dates[index])} · ${depthText(value)}`;
                dot.append(title); graph.append(dot);
            });
        }
        showSelection();
    };
    const nearest = event => {
        const bounds = graph.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / (bounds.width || width) * width;
        return Math.max(0, Math.min(dates.length - 1, Math.round((x - 8) / (width - 16) * (dates.length - 1))));
    };
    const preview = event => {
        if (!enabled || !available() || event.pointerType === 'touch') return;
        const next = nearest(event);
        if (next !== hover) { hover = next; showSelection(); }
    };
    const leave = () => { hover = null; showSelection(); };
    const pin = event => {
        if (!enabled || !available()) return;
        pinned = dates[nearest(event)]; hover = null; showSelection(true);
        frame.focus({ preventScroll: true });
    };
    const keyboard = event => {
        if (!enabled || !available() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const previous = hover ?? dates.indexOf(pinned);
        let index;
        switch (event.key) {
        case 'ArrowLeft': index = previous < 0 ? dates.length - 1 : Math.max(0, previous - 1); break;
        case 'ArrowRight': index = previous < 0 ? 0 : Math.min(dates.length - 1, previous + 1); break;
        case 'Home': index = 0; break;
        case 'End': index = dates.length - 1; break;
        case 'Escape': pinned = null; break;
        default: return;
        }
        event.preventDefault(); hover = null;
        if (index !== undefined) pinned = dates[index];
        showSelection(true);
    };
    frame.addEventListener('pointermove', preview); frame.addEventListener('pointerleave', leave);
    frame.addEventListener('click', pin); frame.addEventListener('keydown', keyboard); frame.addEventListener('blur', leave);
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(draw) : null;
    return {
        update: next => {
            if (disposed) return;
            if (station !== next.station) pinned = null;
            station = next.station; dates = next.dates; values = next.values; loaded = next.loaded;
            if (!dates.includes(pinned)) pinned = null;
            hover = null; draw();
        },
        setEnabled: next => {
            if (disposed || enabled === next) return;
            enabled = next; hover = null;
            observer?.disconnect(); if (enabled) observer?.observe(frame);
            draw();
        },
        dispose: () => {
            disposed = true; observer?.disconnect();
            frame.removeEventListener('pointermove', preview); frame.removeEventListener('pointerleave', leave);
            frame.removeEventListener('click', pin); frame.removeEventListener('keydown', keyboard); frame.removeEventListener('blur', leave);
        },
    };
}
