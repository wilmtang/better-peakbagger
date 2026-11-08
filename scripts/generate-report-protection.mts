// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Chrome caps each compiled RE2 expression at 2 KiB. A single fully encoded
// route exceeds that cap. Compose small endpoint rules with folder exclusions;
// Firefox consumes the same generated policy and priority cutoff.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type FrameType = 'main_frame' | 'sub_frame';
export interface ReportRule {
    id: number; priority: number;
    action: { type: 'allow' | 'modifyHeaders'; responseHeaders?: { header: string; operation: 'append'; value: string }[] };
    condition: { regexFilter: string; requestDomains: string[]; resourceTypes: FrameType[]; isUrlFilterCaseSensitive: boolean;
        excludedResponseHeaders?: { header: string; values: string[] }[] };
}

export const REPORT_CSP_VALUE = "script-src 'none'; object-src 'none'; base-uri 'none'; frame-src "
    + ['https://peakbagger.com:*', 'https://www.peakbagger.com:*'].flatMap(origin =>
        ['/map/MasterMap.aspx', '/map/mastermap.aspx', '/Map/MasterMap.aspx', '/Map/mastermap.aspx'].map(route => origin + route)).join(' ')
    + ' https://www.youtube.com/embed/ chrome-extension: moz-extension:';

// requestDomains also matches subdomains. Exactly two host labels, or literal
// www plus two labels, together with that suffix condition enforce the two
// canonical hosts even when optional all-host access has been granted.
const AUTHORITY = '^https://(?:[\\x21-\\x2e\\x30-\\x7e]*@)?(?:www\\.)?[a-z0-9-]+\\.[a-z0-9:-]+';
const ROOT_CHAR = '[A-Za-z0-9%._~-]';
const PATH_ASCII = '[\\x21-\\x22\\x24-\\x3e\\x40-\\x7e]'; // no literal ? or #
const HEX = '0123456789abcdefABCDEF';
const ROOT_LITERAL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-';
const END = '(?:[/?#;]|$)';

// Prefix-free compiler-sized partitions. 0 selects the literal filename byte;
// 1 selects its percent encoding. Remaining bytes retain both alternatives.
// Keep exhaustive alias coverage and real compiler checks when changing these.
export const REPORT_PARTITIONS = ['00', '010', '100', '0110', '0111', '1010', '1011', '1100', '1101', '1110', '11110', '111110', '111111']
    .flatMap(prefix => [prefix + '0', prefix + '1']); // headroom for the trailing-dot boundary
export const MAP_PARTITIONS = ['00', '010', '011', '100', '101', '110', '1110', '1111'];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hexCase = (text: string) => text.replace(/[a-f]/g, character => `[${character}${character.toUpperCase()}]`);
const options = (text: string, fixedCase = false) => [...text].map(character => {
    if (character === '.') return ['\\.', '%2[eE]'];
    const lower = character.toLowerCase(), upper = character.toUpperCase();
    return fixedCase ? [escape(character), '%' + hexCase(character.charCodeAt(0).toString(16))]
        : [`[${lower}${upper}]`, `%[${upper.charCodeAt(0).toString(16)[0]}${lower.charCodeAt(0).toString(16)[0]}]${hexCase(lower.charCodeAt(0).toString(16)[1])}`];
});
const spelling = (word: string, prefix = '', fixedCase = false) => options(word, fixedCase).map((choice, index) =>
    index < prefix.length ? choice[Number(prefix[index])] : `(?:${choice.join('|')})`).join('');
const smallPrefixes = (length: number) => Array.from({ length: 2 ** Math.max(0, length - 4) }, (_, number) =>
    length <= 4 ? '' : number.toString(2).padStart(length - 4, '0'));

// A wrong byte, a short strict prefix, or an extra byte is the complete
// complement of the folder spelling. Previous bytes match exactly, so malformed
// percent signs cannot masquerade as a wrong literal byte in a genuine alias.
const folderComplement = (folder: string) => {
    const result: string[] = [];
    for (let index = 0; index < folder.length; index++) {
        const character = folder[index];
        const high = new Set([character.charCodeAt(0).toString(16)[0], character.toUpperCase().charCodeAt(0).toString(16)[0]]);
        const low = character.charCodeAt(0).toString(16)[1];
        const wrongLiteral = [...ROOT_LITERAL].filter(value => value.toLowerCase() !== character).join('');
        const wrongHigh = [...HEX].filter(value => !high.has(value)).join('');
        const wrongLow = [...HEX].filter(value => value.toLowerCase() !== low).join('');
        const wrongByte = `(?:[${wrongLiteral}]|%(?:[${wrongHigh}][${HEX}]|[${[...high].join('')}][${wrongLow}]))`;
        for (const prefix of smallPrefixes(index)) result.push(AUTHORITY + '/+' + spelling(folder.slice(0, index), prefix) + wrongByte);
    }
    for (let length = 1; length < folder.length; length++) for (const prefix of smallPrefixes(length)) {
        result.push(AUTHORITY + '/+' + spelling(folder.slice(0, length), prefix) + '/');
    }
    for (const prefix of smallPrefixes(folder.length)) result.push(AUTHORITY + '/+' + spelling(folder, prefix) + ROOT_CHAR);
    return result;
};

export function buildReportProtection(): ReportRule[] {
    const rules: ReportRule[] = [];
    const add = (regexFilter: string, resourceTypes: FrameType[], priority: number, allow = false, caseSensitive = true) => rules.push({
        id: rules.length + 1, priority,
        action: allow ? { type: 'allow' } : { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: REPORT_CSP_VALUE }] },
        condition: { regexFilter, requestDomains: ['peakbagger.com'], resourceTypes, isUrlFilterCaseSensitive: caseSensitive,
            ...(!allow && { excludedResponseHeaders: [{ header: 'cf-mitigated', values: ['challenge'] }] }) },
    });
    // Priority contract: default denial 1; folder/map exceptions 2; inverse map
    // folder denial 3; ambiguous encoding denial 4. allow is document-only,
    // never allowAllRequests, and cannot suppress report-media's non-PB requests.
    add(AUTHORITY + '/', ['sub_frame'], 1);
    for (const prefix of REPORT_PARTITIONS) add(AUTHORITY + '/+' + ROOT_CHAR + '+/+' + spelling('ascent.aspx', prefix) + '\\.*' + END, ['main_frame'], 1);
    for (const regex of folderComplement('climber')) add(regex, ['main_frame'], 2, true);
    // Retain the old case-insensitive native spelling; encoded filenames follow
    // the two spellings allowed by the parent's existing frame-src policy.
    add('^https://(?:www\\.)?peakbagger\\.com(?::[0-9]+)?/+map/+mastermap\\.aspx(?:[?#]|$)', ['sub_frame'], 2, true, false);
    for (const word of ['MasterMap.aspx', 'mastermap.aspx']) for (const prefix of MAP_PARTITIONS) {
        add(AUTHORITY + '/+' + ROOT_CHAR + '+/+' + spelling(word, prefix, true) + '(?:[?#]|$)', ['sub_frame'], 2, true);
    }
    for (const regex of folderComplement('map')) add(regex, ['sub_frame'], 3);
    // Only ASCII unreserved byte aliases are unambiguous without knowing the
    // server's decoder/rewrite configuration. Nested/reserved/control/non-ASCII
    // encodings and malformed escapes remain fail-closed, on the path only.
    const unsafeByte = '(?:[0189a-fA-F][0-9a-fA-F]|2[0-9a-cA-CfF]|3[a-fA-F]|40|5[b-eB-E]|60|7[b-dB-DfF])';
    const nonHex = '[\\x21-\\x2f\\x3a-\\x40\\x47-\\x60\\x67-\\x7e]';
    add(AUTHORITY + '/' + PATH_ASCII + '*%(?:' + unsafeByte + '|' + nonHex + '|[0-9a-fA-F](?:' + nonHex + '|$)|$)', ['main_frame', 'sub_frame'], 4);
    const dot = '(?:\\.|%2[eE])';
    // Windows-style trimming can also make a literal trailing dot ambiguous
    // when a different byte in the same route is encoded. Guard every segment.
    add(AUTHORITY + '/' + PATH_ASCII + '*' + dot + END, ['main_frame', 'sub_frame'], 4);
    if (rules.length >= 900) throw new Error('Report policy exceeded its reserved static-regex budget');
    return rules;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [mode, ...extra] = process.argv.slice(2);
    if (extra.length || !['--write', '--check'].includes(mode)) throw new Error('Usage: node scripts/generate-report-protection.mts --write|--check');
    const target = new URL('../src/reports/report-protection.json', import.meta.url);
    const expected = JSON.stringify(buildReportProtection(), null, 2) + '\n';
    if (mode === '--write') await writeFile(target, expected);
    else if (await readFile(target, 'utf8') !== expected) throw new Error('Report policy is stale; regenerate it with --write');
    console.log(`Report policy ${mode === '--write' ? 'generated' : 'checked'} (${buildReportProtection().length} rules)`);
}
