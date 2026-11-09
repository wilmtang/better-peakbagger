// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { metadataUrl, onlineReadiness, probeReadiness, readinessArguments, validateReadiness, validateTilePng } from '../../scripts/release-readiness.mts';

const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const metadata = JSON.parse(await readFile(new URL('../../store-assets/release-readiness.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(metadata);
const tileUrl = 'https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/export';
function png() {
    const chunk = (type: string, data: Buffer) => {
        const value = Buffer.alloc(data.length+12); value.writeUInt32BE(data.length);
        value.write(type,4); data.copy(value,8); value.writeUInt32BE(crc32(value.subarray(4,-4)),value.length-4); return value;
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256,4); header[8]=8; header[9]=6;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
        chunk('IDAT',deflateSync(Buffer.alloc(256*(256*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}
const response = () => new Response(new Uint8Array(png()), {headers:{'access-control-allow-origin':'*','content-type':'image/png'}});

test('maintained readiness copy covers every current permission without claiming dashboard validation', () => {
    const report = validateReadiness(manifest, metadata, {permissions:manifest.permissions.filter((permission: string) => permission!=='declarativeNetRequest')});
    assert.deepEqual(report.addedPermissions,['declarativeNetRequest']);
    assert.match(report.dashboardSession,/not checked/); assert.match(report.googleMetadata,/not checked/);
    assert.deepEqual(Object.keys(report.metadata.permissionJustifications).sort(),manifest.permissions.slice().sort());
    assert.equal(validateReadiness(manifest, metadata).addedPermissions,null,'missing previous manifest stays unknown');
    const missing=clone();delete missing.permissionJustifications.declarativeNetRequest;
    assert.throws(()=>validateReadiness(manifest,missing),/declarativeNetRequest justification/);
    const stale=clone();stale.permissionJustifications.tabs='obsolete';assert.throws(()=>validateReadiness(manifest,stale),/stale/);
    const empty=clone();empty.hostPermissionJustification='';assert.throws(()=>validateReadiness(manifest,empty),/Host justification/);
    const long=clone();long.purpose='x'.repeat(1001);assert.throws(()=>validateReadiness(manifest,long),/Single purpose/);
    assert.throws(()=>validateReadiness({...manifest,permissions:['storage','storage']},metadata),/distinct/);
    assert.throws(()=>validateReadiness(manifest,{...metadata,schemaVersion:2}),/schema/);
});

test('readiness includes optional API permissions and reports every host authority category', () => {
    assert.throws(()=>validateReadiness({...manifest,optional_permissions:['downloads']},metadata),/downloads justification/);
    const prepared=clone();prepared.permissionJustifications.downloads='Only explicit user-requested file exports.';
    const candidate={...manifest,optional_permissions:['downloads'],host_permissions:[...manifest.host_permissions,'https://new.example/*'],
        optional_host_permissions:[...manifest.optional_host_permissions,'https://optional.example/*'],
        content_scripts:[...manifest.content_scripts,{matches:['https://injected.example/*']} ]};
    const report=validateReadiness(candidate,prepared,manifest);
    assert.deepEqual(report.addedPermissions,['downloads']);assert.deepEqual(report.addedOptionalPermissions,['downloads']);
    assert.deepEqual(report.addedHostPermissions,['https://new.example/*']);
    assert.deepEqual(report.addedOptionalHostPermissions,['https://optional.example/*']);
    assert.deepEqual(report.addedContentScriptMatches,['https://injected.example/*']);
    const promoted={...manifest,permissions:[...manifest.permissions,'downloads'],optional_permissions:[]};
    const change=validateReadiness(promoted,prepared,candidate);
    assert.deepEqual(change.addedPermissions,[]);assert.deepEqual(change.addedRequiredPermissions,['downloads'],'optional-to-required promotion is visible');
    assert.throws(()=>validateReadiness({...manifest,optional_permissions:['storage']},metadata),/overlap/);
});

test('readiness arguments reject unknown, repeated and ambiguous selections', () => {
    assert.deepEqual(readinessArguments(['--online','--previous-tag','v4.1.0']),{online:true,previousTag:'v4.1.0'});
    for(const args of [['--online','--online'],['--previous-tag'],['--previous-tag','v04.1.0'],['--publish'],['--online=yes'],['--previous-tag','v4.1.0','--previous-tag','v4.0.2']]) assert.throws(()=>readinessArguments(args),/Usage/);
});

test('online metadata checks cannot redirect into credentials, private or unreviewed hosts', async () => {
    for(const value of ['http://github.com/wilmtang','https://user:secret@github.com/x','https://localhost/x','https://127.0.0.1/x','https://github.com:8443/x','https://example.com/x']) assert.throws(()=>metadataUrl(value));
    let calls=0;
    const fetcher: typeof fetch = async () => {calls++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});};
    await assert.rejects(probeReadiness(metadata.urls.homepage,'link',fetcher),/reviewed public/);assert.equal(calls,1);
    await assert.rejects(probeReadiness('http://127.0.0.1/private','tile',fetcher),/Unreviewed/);assert.equal(calls,1);
});

test('tile smoke rejects HTML/errors, missing CORS, truncated PNG and corrupt image data', async () => {
    validateTilePng(png());
    for(const bytes of [Buffer.from('<html>blocked</html>'),png().subarray(0,33),png().subarray(0,-12),Buffer.from(png().map((value,index)=>index===40?value^1:value))]) assert.throws(()=>validateTilePng(bytes));
    await assert.rejects(probeReadiness(tileUrl,'tile',async()=>new Response('<html>blocked</html>',{headers:{'access-control-allow-origin':'*'}})),/PNG/);
    await assert.rejects(probeReadiness(tileUrl,'tile',async()=>new Response(new Uint8Array(png()))),/CORS header/);
    let requests=0;
    await assert.rejects(probeReadiness(tileUrl,'tile',async()=>{requests++;return new Response('',{status:429});}),/HTTP 429/);
    assert.equal(requests,1,'service cooldown responses are not retried');
    assert.equal((await probeReadiness(tileUrl,'tile',async()=>response())).status,200);
});

test('readiness bodies are bounded and cancelled when the byte budget is exceeded', async () => {
    let cancelled=false;
    const body = new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4_000_001));},cancel(){cancelled=true;}});
    await assert.rejects(probeReadiness(metadata.urls.homepage,'link',async()=>new Response(body)),/byte budget/);
    assert.equal(cancelled,true);
});

test('optional live smoke executes exactly three links and two public synthetic overlay probes', async () => {
    const urls: string[]=[];
    const tileHosts = new Set(['edits.nationalmap.gov','elevation.nationalmap.gov']);
    const fetcher: typeof fetch = async input => {const url=String(input);urls.push(url);return tileHosts.has(new URL(url).hostname)?response():new Response('public project document');};
    const report=await onlineReadiness(validateReadiness(manifest,metadata).metadata,fetcher);
    assert.equal(report.probes.length,5);assert.equal(urls.length,5);assert.equal(urls.filter(url=>tileHosts.has(new URL(url).hostname)).length,2);
    assert.match(urls.find(url=>url.includes('PAD_US'))!,/dynamicLayers=/,'probe uses the actual all-types renderer request');
    assert.equal(report.googleValidation,'not established');assert.equal(report.browserCorsEnforcement,'not checked');assert.match(report.rendering,/not checked/);
    assert.equal(report.passed,true);
    const failure=await onlineReadiness(validateReadiness(manifest,metadata).metadata,async input=>new URL(String(input)).hostname==='elevation.nationalmap.gov'?new Response('',{status:503}):fetcher(input));
    assert.equal(failure.passed,false);assert.equal(failure.probes.length,5);
    assert.equal(failure.probes.find(probe=>!probe.passed)?.id,'slope');
    assert.equal(failure.probes.find(probe=>!probe.passed)?.host,'elevation.nationalmap.gov');
    assert.ok(failure.probes.every(probe=>!probe.path.includes('?')));
});
