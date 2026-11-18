// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure local trip-report draft identities and lifecycle.
//
// The ascent editor writes these records and the options page manages them.
// Keeping the key and expiry rules here prevents those two surfaces from
// silently disagreeing. This module intentionally has no DOM or browser-API
// dependency.

import { PEAKBAGGER_ORIGIN } from '../peakbagger/peakbagger-origin.ts';

export interface ReportDraftIdentity {
    cid?: string | number | null;
    aid?: string | number | null;
    pid?: string | number | null;
}

export type ReportDraftKind = 'new' | 'ascent' | 'peak';

export type ParsedReportDraftKey =
    | { cid: string; kind: 'new'; id: null }
    | { cid: string; kind: 'ascent' | 'peak'; id: string };

export interface ReportDraftKeyLike {
    cid?: string | null;
    kind?: string | null;
    id?: string | null;
}

export type ReportDraftTitleTarget =
    | { kind: 'ascent' | 'peak'; id: string }
    | { kind: 'new'; id?: string | null };

export interface ReportDraftRecord {
    text: string;
    savedAt: number;
    storageGeneration?: unknown;
    deletedGeneration?: unknown;
    deletedAt?: unknown;
    [key: string]: unknown;
}

export interface ReportDraftVersionLike {
    readonly storageGeneration?: unknown;
    readonly savedAt?: unknown;
    readonly deletedGeneration?: unknown;
    readonly deletedAt?: unknown;
}

const PREFIX = 'bpbReportDraft:';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const LIMIT = 30;
const EDIT_BASE = `${PEAKBAGGER_ORIGIN}/climber/ascentedit.aspx`;
const SAVED_EVENT = 'bpb:report-draft-saved';
const GENERATION_FIELD = 'storageGeneration';
const DELETION_EPOCH_KEY = 'bpbReportDraftDeletionEpoch';

const keyFor = ({ cid, aid, pid }: ReportDraftIdentity = {}): string => {
    const owner = cid || '0';
    const target = aid ? `a${aid}` : pid ? `p${pid}` : 'new';
    return `${PREFIX}${owner}:${target}`;
};

const parseKey = (key: unknown): ParsedReportDraftKey | null => {
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null;
    const match = key.slice(PREFIX.length).match(/^(\d+):(new|a(\d+)|p(-?\d+))$/);
    if (!match?.[1]) return null;

    const cid = match[1];
    if (match[2] === 'new') return { cid, kind: 'new', id: null };
    const id = match[3] || match[4];
    if (!id) return null;
    return {
        cid,
        kind: match[3] ? 'ascent' : 'peak',
        id
    };
};

const editUrl = (parsed: ReportDraftKeyLike | null | undefined): string | null => {
    if (!parsed?.cid || !/^\d+$/.test(parsed.cid)) return null;
    const query: string[] = [];
    if (parsed.kind === 'ascent' && parsed.id && /^\d+$/.test(parsed.id)) query.push(`aid=${parsed.id}`);
    else if (parsed.kind === 'peak' && parsed.id && /^-?\d+$/.test(parsed.id)) query.push(`pid=${parsed.id}`);
    else if (parsed.kind !== 'new' || parsed.id != null) return null;
    if (parsed.cid !== '0') query.push(`cid=${parsed.cid}`);
    return query.length ? `${EDIT_BASE}?${query.join('&')}` : EDIT_BASE;
};

const validRecord = (value: unknown): value is ReportDraftRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.text === 'string'
        && typeof record.savedAt === 'number'
        && Number.isFinite(record.savedAt);
};

// Transport identity only: text and optional display metadata never need to
// travel back to the worker just to compare the editor's observed version.
const version = (value: unknown): string => {
    const record = value && typeof value === 'object' ? (value as ReportDraftVersionLike) : null;
    return JSON.stringify([
        record?.[GENERATION_FIELD] ?? null,
        record?.savedAt ?? null,
        record?.deletedGeneration ?? null,
        record?.deletedAt ?? null,
    ]);
};

const fallbackTitle = (parsed: ReportDraftTitleTarget | null | undefined): string => {
    if (!parsed) return 'TR draft';
    if (parsed.kind === 'ascent') return `Ascent #${parsed.id}`;
    if (parsed.kind === 'peak') return `New ascent · peak #${parsed.id}`;
    return 'New ascent';
};

const remainingMs = (record: { readonly savedAt: number }, now = Date.now()): number => TTL_MS - (now - record.savedAt);

export const reportDrafts = {
    PREFIX,
    TTL_MS,
    LIMIT,
    SAVED_EVENT,
    GENERATION_FIELD,
    DELETION_EPOCH_KEY,
    keyFor,
    parseKey,
    editUrl,
    validRecord,
    version,
    fallbackTitle,
    remainingMs
};
