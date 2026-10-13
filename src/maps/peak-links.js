// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — focused external planning links for Peak.aspx.
// Reads only the peak's displayed WGS84 decimal coordinates and fails closed
// if the coordinate row is missing/ambiguous. General and map links each
// require their own unambiguous native section.

import { readPeakNations } from '../avalanche/avalanche-location.js';
import { resolveAvalancheLinks } from '../avalanche/avalanche-links.js';

(() => {
    'use strict';

    const PANEL_ID = 'bpb-peak-links';

    const normalize = text => (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const coordinateRows = Array.from(document.querySelectorAll('tr')).filter(row => {
        if (row.cells.length < 2) return false;
        return normalize(row.cells[0].textContent).toLowerCase() === 'latitude/longitude (wgs84)';
    });
    if (coordinateRows.length !== 1) return;
    const [coordinateRow] = coordinateRows;

    // Parse only Peakbagger's explicitly labelled decimal-degree value. The
    // same cell also contains DMS and UTM forms, which must never be mistaken
    // for the summit coordinate.
    const coordinateText = normalize(coordinateRow.cells[1].textContent);
    if ((coordinateText.match(/\(Dec Deg\)/gi) || []).length !== 1) return;
    const match = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\(Dec Deg\)/i.exec(coordinateText);
    if (!match) return;

    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;

    // Keep Peakbagger's source precision instead of round-tripping through a
    // Number (which can switch very small values to exponent notation). Windy
    // requires a decimal part, so append one only for integer source values.
    const formatCoordinate = value => value.includes('.') ? value : `${value}.0`;
    const lat = formatCoordinate(match[1]);
    const lon = formatCoordinate(match[2]);

    // Keep the injection anchored to the same native peak-details table as the
    // coordinate row. A generic bold "Links" elsewhere is not enough evidence.
    const peakTable = coordinateRow.closest('table');
    if (!peakTable) return;

    // Web Map Links lives in the other native details table. Keep these
    // additions distinct, and do not depend on the general Links section.
    const mapRows = Array.from(document.querySelectorAll('tr')).filter(row =>
        row.cells.length === 2 && normalize(row.cells[0].textContent).toLowerCase() === 'web map links'
        && row.closest('table')?.matches('table.gray[align="right" i]')
        && row.closest('table').parentElement === peakTable.parentElement);
    if (mapRows.length === 1 && !document.getElementById('bpb-peak-map-links')) {
        const group = document.createElement('div');
        group.id = 'bpb-peak-map-links';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Maps added by Better Peakbagger');
        const badge = document.createElement('abbr');
        badge.className = 'bpb-peak-map-links__badge';
        badge.title = 'Better Peakbagger';
        badge.textContent = 'BPB';
        group.append(badge);
        // AllTrails uses a visible bounding box; clip it at the coordinate
        // limits so peaks near a pole or the date line still produce valid URLs.
        const bounds = new URLSearchParams({
            b_tl_lat: Math.min(90, latitude + .05).toFixed(6),
            b_tl_lng: Math.max(-180, longitude - .05).toFixed(6),
            b_br_lat: Math.max(-90, latitude - .05).toFixed(6),
            b_br_lng: Math.min(180, longitude + .05).toFixed(6),
            mobileMap: 'true',
        });
        for (const [label, href] of [
            ['Gaia GPS', `https://www.gaiagps.com/map/?loc=13/${lon}/${lat}`],
            ['AllTrails', `https://www.alltrails.com/explore?${bounds}`],
            ['onX Backcountry', `https://webmap.onxmaps.com/backcountry/map?latlon=${lat},${lon},13`],
        ]) {
            const anchor = document.createElement('a');
            anchor.textContent = label;
            anchor.href = href;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            group.append(anchor);
        }
        mapRows[0].cells[1].append(group);
    }

    if (document.getElementById(PANEL_ID)) return;

    // Read Peakbagger's own "Nation" row to gate country-specific services.
    // Absent or unexpected values simply omit those links (fail closed).
    const nations = readPeakNations(peakTable);
    const linksHeadings = Array.from(peakTable.querySelectorAll('b, strong'))
        .filter(element => element.closest('table') === peakTable
            && normalize(element.textContent).toLowerCase() === 'links');
    if (linksHeadings.length !== 1 || !linksHeadings[0].closest('td')) return;
    const [linksHeading] = linksHeadings;

    const section = document.createElement('section');
    section.id = PANEL_ID;
    section.setAttribute('aria-labelledby', `${PANEL_ID}-heading`);

    const heading = document.createElement('div');
    heading.id = `${PANEL_ID}-heading`;
    heading.className = 'bpb-peak-links__heading';
    heading.textContent = 'Better Peakbagger links';
    section.appendChild(heading);

    const linkList = document.createElement('div');
    linkList.className = 'bpb-peak-links__list';

    const addLink = (label, description, href) => {
        const item = document.createElement('div');
        item.className = 'bpb-peak-links__item';

        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = label;

        const detail = document.createElement('span');
        detail.className = 'bpb-peak-links__detail';
        detail.textContent = description;

        item.append(anchor, detail);
        linkList.appendChild(item);
    };

    addLink(
        'Windy summit forecast',
        'Weather detail at this peak',
        `https://www.windy.com/${lat}/${lon}`
    );
    addLink(
        'Copernicus satellite imagery',
        'Browse images by date and cloud cover, or choose Sentinel-2 in the map’s layer menu.',
        `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
    );

    // AirNow's Fire and Smoke Map covers the United States, Canada, and Mexico.
    if (nations.some(nation => ['united states', 'canada', 'mexico'].includes(nation))) {
        addLink(
            'AirNow fire & smoke',
            'Active wildfires and smoke near this peak',
            `https://fire.airnow.gov/#9/${lat}/${lon}`
        );
    }

    const avalanche = resolveAvalancheLinks({ nations, latitude, longitude });
    for (const link of avalanche.links) addLink(link.label, link.detail, link.href);
    if (avalanche.unconfigured) {
        const item = document.createElement('div');
        item.className = 'bpb-peak-links__item';
        const label = document.createElement('span');
        label.textContent = 'Avalanche forecasts';
        const detail = document.createElement('span');
        detail.className = 'bpb-peak-links__detail';
        detail.textContent = avalanche.links.length
            ? 'No forecast source configured for one of the listed countries.'
            : 'No forecast source configured for this location.';
        item.append(label, detail);
        linkList.append(item);
    }

    section.appendChild(linkList);

    // Peakbagger currently places two line breaks after its Links heading.
    // Insert after those when present, while remaining safe if the legacy
    // markup changes slightly.
    let insertionPoint = linksHeading;
    while (insertionPoint.nextSibling?.nodeName === 'BR') insertionPoint = insertionPoint.nextSibling;
    insertionPoint.parentNode.insertBefore(section, insertionPoint.nextSibling);
})();
