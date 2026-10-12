// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dom } from '../ui/dom.js';

// Packaged SVGs share one palette across daily summaries and hourly readings.
// The adjacent condition text (or the hourly accessible name) carries meaning.
export function createWeatherIcon(kind, { night = false, label, title, className = '' } = {}) {
    const symbol = dom.element('span', { class: `bpb-weather-symbol ${className}` });
    if (label) { symbol.setAttribute('role', 'img'); symbol.setAttribute('aria-label', label); }
    else symbol.setAttribute('aria-hidden', 'true');
    if (title) symbol.title = title;
    symbol.dataset.condition = night && ['sun', 'partly'].includes(kind) ? kind === 'sun' ? 'moon' : 'partly-night' : kind;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    const add = (tag, attrs, tone) => {
        const node = document.createElementNS(svg.namespaceURI, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        node.setAttribute('class', `bpb-weather-symbol__${tone}`); svg.append(node);
    };
    if (kind === 'sun' || kind === 'partly') {
        if (night) add('path', { d: 'M22 3a10 10 0 1 0 7 16A10 10 0 0 1 22 3Z' }, 'moon');
        else {
            const center = kind === 'sun' ? 16 : 12;
            add('circle', { cx: center, cy: center, r: 5 }, 'sun');
            add('path', { d: `M${center} ${center - 12}v3m0 18v3m-12-12h3m18 0h3m-20.5-8.5 2 2m13 13 2 2m-17 0 2-2m13-13 2-2` }, 'rays');
        }
    }
    if (['cloud', 'partly', 'rain', 'snow', 'fog', 'storm'].includes(kind)) {
        add('path', { d: 'M8 23a5.5 5.5 0 0 1-1-10.9 7.5 7.5 0 0 1 14.4-2.3A6.7 6.7 0 1 1 25 23Z' }, 'cloud');
    }
    if (kind === 'rain') add('path', { d: 'm10 26-1 3m8-3-1 3m8-3-1 3' }, 'rain');
    if (kind === 'snow') add('path', { d: 'M16 24v7m-3-5.5 6 4m-6 0 6-4' }, 'snow');
    if (kind === 'fog') add('path', { d: 'M4 26h24M7 30h18' }, 'fog');
    if (kind === 'storm') add('path', { d: 'm17 19-5 7h5l-2 6 8-10h-6l3-3Z' }, 'storm');
    if (!['sun', 'cloud', 'partly', 'rain', 'snow', 'fog', 'storm'].includes(kind)) add('path', { d: 'M10 16h12' }, 'fog');
    symbol.append(svg);
    return symbol;
}
