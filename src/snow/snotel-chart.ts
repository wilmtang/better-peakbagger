// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StableText } from '../ui/stable-text.ts';

export interface SnotelChartOptions {
    frame: HTMLElement;
    graph: SVGSVGElement;
    empty: HTMLElement;
    maximum: HTMLElement;
    zero: HTMLElement;
    ticks: readonly HTMLElement[];
    caption: StableText;
    timeLabel: (time: number, offset?: number, includeOffset?: boolean) => string;
    depthText: (mm: number | null) => string;
}

export interface SnotelChartData {
    station: string | null;
    times: readonly number[];
    values: readonly (number | null)[];
    offset: number;
    loaded: boolean;
}

export interface SnotelChart {
    update(next: SnotelChartData): void;
    setEnabled(next: boolean): void;
    dispose(): void;
}

// The caption doubles as the readout. Inspecting a point never inserts a row
// or changes the plot's scale; missing hours remain gaps, including under focus.
export function createSnotelChart({ frame, graph, empty, maximum, zero, ticks, caption, timeLabel, depthText }: SnotelChartOptions): SnotelChart {
    const doc = frame.ownerDocument, win = doc.defaultView;
    const hint = 'Hourly snow depth · Past 48 hours · Hover, tap or use ← →';
    caption.reserve([hint, 'Hourly snow depth unavailable', 'Sep 30, 12:59 PM · UTC−09 · Snow depth unavailable',
        'Sep 30, 12:59 PM · UTC−09 · Snow depth 3810.0 cm', 'Sep 30, 12:59 PM · UTC−09 · Snow depth 1500.0 in']);
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', 'Hourly snow depth over the past 48 hours. Times use the station’s fixed UTC offset. Each point is one observation, not snowfall during the hour. Use Left and Right, Home and End for readings; Escape to clear.');
    const readout = doc.createElement('span');
    readout.className = 'bpb-snow-chart-status'; readout.setAttribute('role', 'status'); readout.setAttribute('aria-atomic', 'true');
    frame.append(readout);
    let station: string | null = null, times: readonly number[] = [], values: readonly (number | null)[] = [];
    let offset = 0, loaded = false, enabled = false, disposed = false;
    let pinned: number | null = null, hover: number | null = null, width = 320, height = 80;
    const available = () => values.some(value => value !== null);
    const svg = (tag: string, attributes: Record<string, string | number>) => {
        const node = doc.createElementNS(graph.namespaceURI, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
    };
    const xAt = (index: number) => 8 + index * (width - 16) / Math.max(1, times.length - 1);
    const maxValue = () => Math.max(1, ...values.filter((value): value is number => value !== null));
    const yAt = (value: number) => height * (.85 - value / maxValue() * .55);
    const selectedText = (index: number) => `${timeLabel(times[index], offset)} · Snow depth ${values[index] === null ? 'unavailable' : depthText(values[index])}`;
    const showSelection = (announce = false) => {
        graph.querySelectorAll('.bpb-snow-cursor, .bpb-snow-selected').forEach(node => node.remove());
        const index = hover ?? (pinned !== null ? times.indexOf(pinned) : -1);
        const selected = enabled && available() && index >= 0 && index < times.length;
        const text = selected ? selectedText(index) : available() ? hint : loaded ? 'Hourly snow depth unavailable' : 'Hourly snow-depth trend';
        caption.set(text);
        if (announce) readout.textContent = selected ? text : 'Selection cleared.';
        if (!selected) return;
        const x = xAt(index);
        graph.append(svg('path', { d: `M${x},${height * .17}V${height * .9}`, class: 'bpb-snow-cursor' }));
        const selectedValue = values[index];
        if (selectedValue !== null) graph.append(svg('circle', { cx: x, cy: yAt(selectedValue), r: 4, class: 'bpb-snow-selected' }));
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
        maximum.textContent = depthText(Math.max(0, ...values.filter((value): value is number => value !== null)));
        empty.textContent = loaded ? 'No hourly snow-depth readings' : 'Hourly snow-depth trend';
        ticks.forEach(tick => { tick.textContent = loaded ? timeLabel(times[Number(tick.dataset.hour)], offset, false) : ''; });
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
                const title = svg('title', {}); title.textContent = selectedText(index);
                dot.append(title); graph.append(dot);
            });
        }
        showSelection();
    };
    const nearest = (event: MouseEvent) => {
        const bounds = graph.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / (bounds.width || width) * width;
        return Math.max(0, Math.min(times.length - 1, Math.round((x - 8) / (width - 16) * (times.length - 1))));
    };
    const preview = (event: PointerEvent) => {
        if (!enabled || !available() || event.pointerType === 'touch') return;
        const next = nearest(event);
        if (next !== hover) { hover = next; showSelection(); }
    };
    const leave = () => { hover = null; showSelection(); };
    const pin = (event: MouseEvent) => {
        if (!enabled || !available()) return;
        pinned = times[nearest(event)]; hover = null; showSelection(true);
        frame.focus({ preventScroll: true });
    };
    const keyboard = (event: KeyboardEvent) => {
        if (!enabled || !available() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const previous = hover ?? (pinned !== null ? times.indexOf(pinned) : -1);
        let index: number | undefined;
        switch (event.key) {
        case 'ArrowLeft': index = previous < 0 ? times.length - 1 : Math.max(0, previous - 1); break;
        case 'ArrowRight': index = previous < 0 ? 0 : Math.min(times.length - 1, previous + 1); break;
        case 'Home': index = 0; break;
        case 'End': index = times.length - 1; break;
        case 'Escape': pinned = null; break;
        default: return;
        }
        event.preventDefault(); hover = null;
        if (index !== undefined) pinned = times[index];
        showSelection(true);
    };
    frame.addEventListener('pointermove', preview); frame.addEventListener('pointerleave', leave);
    frame.addEventListener('click', pin); frame.addEventListener('keydown', keyboard); frame.addEventListener('blur', leave);
    const observer = typeof win?.ResizeObserver === 'function' ? new win.ResizeObserver(draw) : null;
    return {
        update: next => {
            if (disposed) return;
            if (station !== next.station) pinned = null;
            station = next.station; times = next.times; values = next.values; offset = next.offset; loaded = next.loaded;
            if (pinned !== null && !times.includes(pinned)) pinned = null;
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
