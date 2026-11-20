/// <reference lib="dom" />
// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A CalTopo map page with its import panel, driven through the injected
// prepareCaltopoImport function as the extension runs it.

import { FixtureDom } from '../helpers/fixture-dom.mts';
import { prepareCaltopoImport } from '../../src/caltopo/caltopo-import.ts';

export const GPX = '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>';
export const run = async ({ url = 'https://caltopo.com/map.html', before = '', duplicate = false,
    ready = true, empty = false, gpx = GPX, filename = 'peakbagger-42.gpx', repeat = false } = {}) => {
    const dom = new FixtureDom(`<div id="page_left"><div class="action-button-js"><img src="/static/images/import.svg">Import</div></div>${before}`, {
        url,
    });
    const win = dom.window;
    let handoffs = 0, imports = 0, received: File | undefined;
    win.document.querySelector('.action-button-js').onclick = () => {
        const panel = win.document.createElement('div'); panel.className = 'yui-panel';
        panel.innerHTML = '<div class="hd">Importer</div><input id="file" type="file"><button>Import</button>';
        const input = panel.querySelector('input')!;
        panel.querySelector('button')!.onclick = () => { throw new Error('adapter must not click Import'); };
        input.onchange = () => {
            received = input.files?.[0]; handoffs++;
            if (!ready) return;
            panel.style.display = 'none';
            const preview = win.document.createElement('div'); preview.className = 'yui-panel';
            preview.innerHTML = '<div class="hd">Import Data</div><table><tbody>'
                + (empty ? '' : '<tr><td><input type="checkbox" checked><input type="text" value="Saved ascent"></td></tr>')
                + '</tbody></table><button>Import</button>';
            preview.querySelector('button')!.onclick = () => imports++;
            win.document.body.append(preview);
        };
        if (duplicate) panel.append(input.cloneNode());
        win.document.body.append(panel);
    };
    const args = JSON.stringify({ gpx, filename, timeoutMs: 100 });
    const invoke = () => win.eval(`(${prepareCaltopoImport.toString()})(${args})`) as Promise<{ ok: boolean; supplied?: boolean; [field: string]: unknown }>;
    const result = structuredClone(await invoke());
    const second = repeat ? structuredClone(await invoke()) : null;
    const file = received;
    const text = file ? await new Promise<string>(resolve => {
        const reader = new win.FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(file);
    }) : null;
    win.close();
    return { result, second, handoffs, imports, text };
};

