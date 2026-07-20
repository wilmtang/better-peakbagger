// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure profile-backup primitives shared by the ClimbListC content script and
// fixture/unit tests. No extension APIs or ambient document are read here.

const trim = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const numericParam = (href, name, base = 'https://peakbagger.com/') => {
    try {
        const raw = new URL(href, base).searchParams.get(name);
        return /^-?\d+$/.test(raw || '') ? Number(raw) : null;
    } catch { return null; }
};

const findLink = (row, pathPattern) => Array.from(row.querySelectorAll('a[href]')).find(anchor => {
    if (anchor.closest('tr') !== row) return false;
    try { return pathPattern.test(new URL(anchor.href, 'https://peakbagger.com/').pathname); }
    catch { return false; }
}) || null;

const ownerClimberId = doc => {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const owner = links.find(anchor => /^My Ascents$/i.test(trim(anchor.textContent)))
        || links.find(anchor => /^Add Ascent$/i.test(trim(anchor.textContent)));
    return owner ? numericParam(owner.href, 'cid', doc.baseURI) : null;
};

const dateFromText = value => {
    const text = trim(value);
    const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    return match ? match[0] : '';
};

const parseAscentList = (doc, { url = doc && doc.baseURI } = {}) => {
    if (!doc || !doc.querySelectorAll) return { isOwner: false, climberId: null, ascents: [] };
    const pageClimberId = numericParam(url, 'cid', doc.baseURI);
    const ownerId = ownerClimberId(doc);
    const ascents = [];

    for (const row of doc.querySelectorAll('tr')) {
        const ascentLink = findLink(row, /\/climber\/ascent\.aspx$/i);
        const peakLink = findLink(row, /\/peak\.aspx$/i);
        if (!ascentLink || !peakLink) continue;
        const editLink = findLink(row, /\/climber\/ascentedit\.aspx$/i);
        const aid = numericParam(ascentLink.href, 'aid', doc.baseURI);
        const pid = numericParam(peakLink.href, 'pid', doc.baseURI);
        if (aid == null || pid == null) continue;
        const trMatch = Array.from(row.cells).map(cell => /^TR-(\d+)$/i.exec(trim(cell.textContent))).find(Boolean);
        const hasGpx = Array.from(row.querySelectorAll('img')).some(image =>
            /(?:^|\/)gps\.gif(?:$|[?#])/i.test(image.src || image.getAttribute('src') || '')
            || /ascent has (?:a )?gps track/i.test(image.title || ''));
        ascents.push({
            aid,
            pid,
            peakName: trim(peakLink.textContent),
            date: dateFromText(ascentLink.textContent),
            hasGpx,
            trWords: trMatch ? Number(trMatch[1]) : 0,
            ascentUrl: ascentLink.href,
            editUrl: editLink ? editLink.href : null,
        });
    }

    const isOwner = ownerId != null
        && pageClimberId === ownerId
        && ascents.every(ascent => ascent.editUrl);
    return { isOwner, climberId: isOwner ? ownerId : null, ascents: isOwner ? ascents : [] };
};

const ascentIdsFromFolders = folders => new Set((Array.isArray(folders) ? folders : []).flatMap(folder => {
    const leaf = typeof folder === 'string' ? folder : folder && typeof folder.path === 'string' ? folder.path : '';
    const match = /-a(\d+)$/.exec(leaf);
    return match ? [Number(match[1])] : [];
}));

const buildWorkList = (ascents, folders, { refreshAll = false } = {}) => {
    const existing = ascentIdsFromFolders(folders);
    const seen = new Set();
    const unique = (Array.isArray(ascents) ? ascents : []).filter(ascent => {
        if (!ascent || !Number.isFinite(ascent.aid) || seen.has(ascent.aid)) return false;
        seen.add(ascent.aid);
        return true;
    });
    const skipped = refreshAll ? [] : unique.filter(ascent => existing.has(ascent.aid));
    const work = refreshAll ? unique : unique.filter(ascent => !existing.has(ascent.aid));
    return { work, skipped, existing };
};

const fullListUrl = rawUrl => {
    const url = new URL(rawUrl);
    url.searchParams.set('j', '-1');
    url.searchParams.set('y', '9999');
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'AscentDate');
    return url.toString();
};

export const profileBackupCore = {
    parseAscentList,
    ascentIdsFromFolders,
    buildWorkList,
    fullListUrl,
};
