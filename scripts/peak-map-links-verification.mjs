// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document */
import assert from 'node:assert/strict';

// Serialize the same DOM probe into Chrome, Firefox and the card-layout gate.
export function readPeakMapLinks() {
    const groups = [...document.querySelectorAll('#bpb-peak-map-links')];
    const group = groups[0], row = group?.closest('tr');
    const coordinate = [...document.querySelectorAll('tr')].find(row =>
        row.cells[0]?.textContent.trim() === 'Latitude/Longitude (WGS84)');
    return {
        count: groups.length,
        name: group?.getAttribute('aria-label'),
        row: row?.cells[0]?.textContent.trim(),
        mapTable: Boolean(group && group.closest('table') === document.getElementById('Gmap')?.closest('table')),
        coordinate: coordinate?.cells[1]?.textContent.match(/^([\d.+-]+),\s*([\d.+-]+)\s*\(Dec Deg\)/)?.slice(1),
        links: [...(group?.querySelectorAll('a') || [])].map(link => ({
            label: link.textContent, href: link.href, target: link.target, rel: link.rel,
        })),
        native: [...(row?.cells[1]?.querySelectorAll('a') || [])]
            .filter(link => !group.contains(link)).map(link => link.textContent),
    };
}

export function assertPeakMapLinks(state) {
    assert.equal(state.count, 1, `BPB map links missing or duplicated: ${JSON.stringify(state)}`);
    assert.equal(state.name, 'Maps added by Better Peakbagger');
    assert.equal(state.row, 'Web Map Links');
    assert.equal(state.mapTable, true, 'map links belong to the native map table');
    assert.ok(state.native.includes('CalTopo'), 'preserve native map links');
    assert.deepEqual(state.links.map(link => link.label), ['Gaia GPS', 'AllTrails', 'onX Backcountry']);
    assert.equal(state.coordinate?.length, 2, 'displayed peak coordinates must be available');
    const [lat, lon] = state.coordinate.map(Number), [gaia, alltrails, onx] = state.links;
    assert.equal(new URL(gaia.href).searchParams.get('loc'), `13/${state.coordinate[1]}/${state.coordinate[0]}`);
    assert.equal(new URL(onx.href).searchParams.get('latlon'), `${state.coordinate.join(',')},13`);
    assert.equal(new URL(alltrails.href).origin, 'https://www.alltrails.com');
    const bounds = new URL(alltrails.href).searchParams;
    assert.ok(Number(bounds.get('b_tl_lat')) >= lat && Number(bounds.get('b_br_lat')) <= lat);
    assert.ok(Number(bounds.get('b_tl_lng')) <= lon && Number(bounds.get('b_br_lng')) >= lon);
    for (const link of state.links) {
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
    }
}
