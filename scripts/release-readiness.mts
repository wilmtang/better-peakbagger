// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import { overlayTileUrl } from '../src/maps/map-overlay-providers.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadataHosts = new Set(['github.com', 'raw.githubusercontent.com', 'wilmtang.github.io']);
const origin = 'https://www.peakbagger.com';
type RecordValue = Record<string, unknown>;
export interface ReadinessMetadata {
    schemaVersion: 1; urls: {homepage: string; privacy: string; support: string}; purpose: string;
    permissionJustifications: Record<string, string>; hostPermissionJustification: string;
}
function record(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as RecordValue;
}
function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())
        || new Set(value).size !== value.length) throw new Error(`${label} must contain distinct nonempty strings`);
    return value as string[];
}
function copy(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`${label} requires 1–1000 characters`);
    return value;
}
export function metadataUrl(value: unknown): URL {
    if (typeof value !== 'string') throw new Error('Store URLs must be strings');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !metadataHosts.has(url.hostname)) {
        throw new Error('Store URLs must use reviewed public HTTPS project hosts');
    }
    return url;
}
export function validateReadiness(manifestValue: unknown, metadataValue: unknown, previousValue?: unknown) {
    const manifest = record(manifestValue, 'Manifest'), source = record(metadataValue, 'Store metadata');
    if (source.schemaVersion !== 1) throw new Error('Unsupported store-readiness schema');
    const scopes = (value: RecordValue) => {
        const required = strings(value.permissions ?? [], 'Manifest permissions');
        const optional = strings(value.optional_permissions ?? [], 'Optional permissions');
        if (required.some(permission => optional.includes(permission))) throw new Error('Required and optional API permissions overlap');
        const scripts = value.content_scripts ?? [];
        if (!Array.isArray(scripts)) throw new Error('Content scripts must be an array');
        return {required, optional, hosts:strings(value.host_permissions ?? [], 'Host permissions'),
            optionalHosts:strings(value.optional_host_permissions ?? [], 'Optional host permissions'),
            scriptMatches:[...new Set(scripts.flatMap(script => strings(record(script, 'Content script').matches, 'Content script matches')))]};
    };
    const current = scopes(manifest), permissions = [...current.required, ...current.optional];
    const justifications = record(source.permissionJustifications, 'Permission justifications');
    const prepared = Object.fromEntries(permissions.map(permission => [permission, copy(justifications[permission], `${permission} justification`)]));
    if (Object.keys(justifications).some(permission => !permissions.includes(permission))) throw new Error('Remove stale permission justifications');
    const links = record(source.urls, 'Store URLs');
    const urls = {homepage:metadataUrl(links.homepage).href, privacy:metadataUrl(links.privacy).href, support:metadataUrl(links.support).href};
    const previous = previousValue === undefined ? null : scopes(record(previousValue, 'Previous manifest'));
    const added = (values: string[], before?: string[]) => before ? values.filter(value => !before.includes(value)) : null;
    const metadata: ReadinessMetadata = {schemaVersion:1, urls, purpose:copy(source.purpose, 'Single purpose'),
        permissionJustifications:prepared, hostPermissionJustification:copy(source.hostPermissionJustification, 'Host justification')};
    return {metadata, addedPermissions:added(permissions, previous ? [...previous.required, ...previous.optional] : undefined),
        addedRequiredPermissions:added(current.required,previous?.required), addedOptionalPermissions:added(current.optional,previous?.optional),
        addedHostPermissions:added(current.hosts,previous?.hosts), addedOptionalHostPermissions:added(current.optionalHosts,previous?.optionalHosts),
        addedContentScriptMatches:added(current.scriptMatches,previous?.scriptMatches),
        dashboardSession:'not checked — sign in before the long rehearsal',
        googleMetadata:'not checked — validate the uploaded draft in the dashboard before publication'};
}
export function readinessArguments(args: string[]) {
    let online = false, previousTag: string | undefined;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--online' && !online) online = true;
        else if (args[index] === '--previous-tag' && !previousTag && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(args[index + 1] || '')) previousTag = args[++index];
        else throw new Error('Usage: release-readiness.mts [--online] [--previous-tag vX.Y.Z]');
    }
    return {online, previousTag};
}
async function boundedBody(response: Response, limit: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is missing');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const result = await reader.read(); if (result.done) break;
            size += result.value.length;
            if (size > limit) throw new Error('Readiness response exceeds its byte budget');
            chunks.push(result.value);
        }
        return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => {}); }
}
export async function probeReadiness(urlValue: string, kind: 'link' | 'tile', fetchImpl: typeof fetch = fetch) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
        let url = kind === 'link' ? metadataUrl(urlValue) : new URL(urlValue);
        if (kind === 'tile' && (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['edits.nationalmap.gov', 'elevation.nationalmap.gov'].includes(url.hostname))) throw new Error('Unreviewed overlay probe host');
        for (let redirect = 0; redirect <= 3; redirect++) {
            const response = await fetchImpl(url, {redirect:'manual', signal:controller.signal,
                headers:kind === 'tile' ? {Origin:origin} : {}});
            if ([301,302,303,307,308].includes(response.status)) {
                await response.body?.cancel();
                const next = response.headers.get('location');
                if (!next || kind !== 'link' || redirect === 3) throw new Error('Unexpected readiness redirect');
                url = metadataUrl(new URL(next, url).href); continue;
            }
            if (!response.ok) { await response.body?.cancel(); throw new Error(`Readiness request returned HTTP ${response.status}`); }
            const bytes = await boundedBody(response, kind === 'tile' ? 2_000_000 : 4_000_000);
            if (!bytes.length) throw new Error('Readiness response is empty');
            if (kind === 'tile') {
                const cors = response.headers.get('access-control-allow-origin');
                if (cors !== '*' && cors !== origin) throw new Error('Overlay CORS header does not allow Peakbagger');
                validateTilePng(bytes);
            }
            return {status:response.status, bytes:bytes.length, kind};
        }
        throw new Error('Readiness redirect limit exceeded');
    } finally { clearTimeout(timer); }
}
export function validateTilePng(bytes: Buffer) {
    const invalid = () => new Error('Overlay response is not a complete supported 256×256 PNG');
    if (bytes.length < 33 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        || bytes.toString('ascii',12,16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13
        || bytes.readUInt32BE(16) !== 256 || bytes.readUInt32BE(20) !== 256
        || bytes[24] !== 8 || ![2,6].includes(bytes[25]) || bytes[26] || bytes[27] || bytes[28]) throw invalid();
    const compressed: Buffer[] = []; let ended = false;
    for (let offset = 8; offset < bytes.length;) {
        if (offset + 12 > bytes.length) throw invalid();
        const size = bytes.readUInt32BE(offset), next = offset + 12 + size;
        if (next > bytes.length) throw invalid();
        if (crc32(bytes.subarray(offset+4,next-4)) !== bytes.readUInt32BE(next-4)) throw invalid();
        const type = bytes.toString('ascii',offset+4,offset+8);
        if (type === 'IHDR' && offset !== 8) throw invalid();
        if (type === 'IDAT') compressed.push(bytes.subarray(offset+8,offset+8+size));
        if (type === 'IEND') { if (size || next !== bytes.length) throw invalid(); ended = true; }
        offset = next;
    }
    if (!ended || !compressed.length) throw invalid();
    const stride = 256 * (bytes[25] === 6 ? 4 : 3) + 1, expected = stride * 256;
    const pixels = inflateSync(Buffer.concat(compressed), {maxOutputLength:expected});
    if (pixels.length !== expected || Array.from({length:256}, (_, row) => pixels[row*stride]).some(filter => filter > 4)) throw invalid();
}
export async function onlineReadiness(metadata: ReadinessMetadata, fetchImpl: typeof fetch = fetch) {
    // Fixed public terrain tile; never use the user's route or location.
    const tile = {z:12, x:666, y:1432};
    const probes = [...Object.entries(metadata.urls).map(([id,url]) => ({id, url, kind:'link' as const})),
        ...['land','slope'].map(id => ({id, url:overlayTileUrl(id, tile), kind:'tile' as const}))];
    const results = await Promise.all(probes.map(async probe => {
        const address = new URL(probe.url), target = {id:probe.id, host:address.hostname, path:address.pathname};
        try { return {...target, passed:true, ...await probeReadiness(probe.url, probe.kind, fetchImpl)}; }
        catch (error) { return {...target, passed:false, kind:probe.kind, error:(error as Error).message.slice(0,160)}; }
    }));
    if (results.length !== 5) throw new Error('Expected five readiness probes');
    return {passed:results.every(result => result.passed), probes:results, googleValidation:'not established', browserCorsEnforcement:'not checked', rendering:'not checked; PNG/header service smoke only'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = readinessArguments(process.argv.slice(2));
        const previous = args.previousTag ? JSON.parse(execFileSync('git', ['show', `${args.previousTag}:manifest.json`], {cwd:root, encoding:'utf8'})) : undefined;
        const report = validateReadiness(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')),
            JSON.parse(await readFile(path.join(root, 'store-assets/release-readiness.json'), 'utf8')), previous);
        const online = args.online ? await onlineReadiness(report.metadata) : undefined;
        console.log(JSON.stringify({...report, ...(online ? {online} : {})}, null, 2));
        if (online && !online.passed) process.exitCode = 1;
    } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
