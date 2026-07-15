// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — focused external planning links for Peak.aspx.
// Reads only the peak's displayed WGS84 decimal coordinates and fails closed
// if either the coordinate row or native Links section is missing/ambiguous.

(() => {
    'use strict';

    const PANEL_ID = 'bpb-peak-links';
    if (document.getElementById(PANEL_ID)) return;

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
    const linksHeadings = Array.from(peakTable.querySelectorAll('b, strong'))
        .filter(element => normalize(element.textContent).toLowerCase() === 'links');
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
        'Find fresh satelitte data by date and cloud cover',
        `https://browser.dataspace.copernicus.eu/?zoom=13&lat=${lat}&lng=${lon}&themeId=DEFAULT-THEME`
    );

    section.appendChild(linkList);

    // Peakbagger currently places two line breaks after its Links heading.
    // Insert after those when present, while remaining safe if the legacy
    // markup changes slightly.
    let insertionPoint = linksHeading;
    while (insertionPoint.nextSibling?.nodeName === 'BR') insertionPoint = insertionPoint.nextSibling;
    insertionPoint.parentNode.insertBefore(section, insertionPoint.nextSibling);
})();
