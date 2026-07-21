// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure local trip-report draft identities and lifecycle.
//
// The ascent editor writes these records and the options page manages them.
// Keeping the key and expiry rules here prevents those two surfaces from
// silently disagreeing. This module intentionally has no DOM or browser-API
// dependency.

const PREFIX = 'bpbReportDraft:';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LIMIT = 30;
const EDIT_BASE = 'https://peakbagger.com/climber/ascentedit.aspx';

const keyFor = ({ cid, aid, pid } = {}) => {
    const owner = cid || '0';
    const target = aid ? `a${aid}` : pid ? `p${pid}` : 'new';
    return `${PREFIX}${owner}:${target}`;
};

const parseKey = key => {
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null;
    const match = key.slice(PREFIX.length).match(/^(\d+):(new|([ap])(\d+))$/);
    if (!match) return null;

    const cid = match[1];
    if (match[2] === 'new') return { cid, kind: 'new', id: null };
    return {
        cid,
        kind: match[3] === 'a' ? 'ascent' : 'peak',
        id: match[4]
    };
};

const editUrl = parsed => {
    if (!parsed || !/^\d+$/.test(parsed.cid || '')) return null;
    const query = [];
    if (parsed.kind === 'ascent' && /^\d+$/.test(parsed.id || '')) query.push(`aid=${parsed.id}`);
    else if (parsed.kind === 'peak' && /^\d+$/.test(parsed.id || '')) query.push(`pid=${parsed.id}`);
    else if (parsed.kind !== 'new' || parsed.id != null) return null;
    if (parsed.cid !== '0') query.push(`cid=${parsed.cid}`);
    return query.length ? `${EDIT_BASE}?${query.join('&')}` : EDIT_BASE;
};

const validRecord = value => !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.text === 'string'
    && typeof value.savedAt === 'number'
    && Number.isFinite(value.savedAt);

const fallbackTitle = parsed => {
    if (!parsed) return 'Report draft';
    if (parsed.kind === 'ascent') return `Ascent #${parsed.id}`;
    if (parsed.kind === 'peak') return `New ascent · peak #${parsed.id}`;
    return 'New ascent';
};

const remainingMs = (record, now = Date.now()) => TTL_MS - (now - record.savedAt);

export const reportDrafts = {
    PREFIX,
    TTL_MS,
    LIMIT,
    keyFor,
    parseKey,
    editUrl,
    validRecord,
    fallbackTitle,
    remainingMs
};
