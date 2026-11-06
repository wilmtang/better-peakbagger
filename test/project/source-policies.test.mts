// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AUTHORED_SOURCE_ROOTS } from '../../scripts/build-config.mts';
import { runtimeSources, sourceVariants } from '../helpers/runtime-sources.mts';
import type { RuntimeSource } from '../helpers/runtime-sources.mts';
import { unitConstantFindings, settingsDefaultFindings, uploadLimitFindings, cloudflareFindings, originFindings,
    deadlineFindings, settingsReadCounts } from '../helpers/source-policies.mts';

const guards: {name: string; code: string; check: (source: RuntimeSource) => string[]}[] = [
    {name:'units', code:'export const feet: number = 3.28084;', check:unitConstantFindings},
    {name:'defaults', code:'let pref: string = "system";', check:settingsDefaultFindings},
    {name:'upload', code:'const points: number[] = []; export const tooMany = points.length > 3000;', check:uploadLimitFindings},
    {name:'cloudflare', code:'export const marker: string = "cf-mitigated";', check:cloudflareFindings},
    {name:'origin', code:'export const hosts = new Set<string>(["peakbagger.com"]);', check:originFindings},
    {name:'deadline', code:'export const response: Promise<Response> = fetch("https://example.invalid/point");', check:deadlineFindings},
];
test('the actual policy functions reject forbidden typed source in every authored root and Svelte scripts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(),'bpb-source-policies-'));
    try {
        for (const entry of AUTHORED_SOURCE_ROOTS) {
            const domain = path.join(directory,entry,'policy-fixture'); await mkdir(domain,{recursive:true});
            for (const guard of guards) for (const extension of ['ts','svelte']) {
                await writeFile(path.join(domain,`${guard.name}.${extension}`), extension === 'svelte'
                    ? `<script lang="ts">${guard.code}</script><span>Fixture</span>` : guard.code);
            }
            await writeFile(path.join(domain,'settings.ts'),'Settings.get<unknown>(); Settings.requireCurrent<unknown>();');
            await writeFile(path.join(domain,'settings.svelte'),'<script lang="ts">settings.get<unknown>(); settings.requireCurrent<unknown>();</script>');
            await writeFile(path.join(domain,'handler.svelte'),'<button onclick={() => fetch("https://example.invalid/point")}>Load</button>');
        }
        const sources = await runtimeSources(directory);
        for (const guard of guards) {
            const candidates = sources.filter(source => source.file.includes(`/${guard.name}.`));
            assert.equal(candidates.length, AUTHORED_SOURCE_ROOTS.length * 2);
            for (const source of candidates) {
                const findings = guard.check(source); assert.ok(findings.length > 0, `${guard.name} missed ${source.file}`);
                // This is the production guard's assertion, with the expected
                // failure tied to the forbidden value/call, not fixture setup.
                assert.throws(() => assert.deepEqual(findings, []), {name:'AssertionError'});
            }
            assert.equal(candidates.filter(source => source.file.endsWith('.js')).length, 0, 'the old walker would silently skip all cases');
        }
        for (const method of ['get','requireCurrent'] as const) {
            const counts = settingsReadCounts(sources,method);
            assert.equal(Object.keys(counts).length,AUTHORED_SOURCE_ROOTS.length * 2);
            assert.ok(Object.values(counts).every(count => count === 1), 'raw and erased variants count each actual call only once');
        }
        assert.equal(sources.filter(source => source.file.endsWith('/handler.svelte')).flatMap(deadlineFindings).length,AUTHORED_SOURCE_ROOTS.length);
    } finally {await rm(directory,{recursive:true,force:true});}
});
test('reviewed owners and deadline exceptions retain their narrow boundaries', () => {
    const source = (file: string, text: string): RuntimeSource => ({file,text,variants:sourceVariants(file,text)});
    assert.deepEqual(unitConstantFindings(source('src/ui/units.js','const feet = 3.28084;')),[]);
    assert.equal(unitConstantFindings(source('photos/units.js','const feet = 3.28084;')).length,1);
    assert.deepEqual(settingsDefaultFindings(source('src/settings/settings-schema.js','let pref = "system";')),[]);
    assert.deepEqual(uploadLimitFindings(source('src/capture/upload-limits.js','points.length > 3000')),[]);
    assert.deepEqual(cloudflareFindings(source('src/capture/provider-response.js','"cf-mitigated"')),[]);
    assert.equal(cloudflareFindings(source('src/capture/provider-response.js','"Complete check on Peakbagger"')).length,1);
    const exception = 'fetch(url); setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); readBoundedResponseText(response); clearTimeout(timeout);';
    assert.deepEqual(deadlineFindings(source('src/maps/peak-markers.js',exception)),[]);
    assert.equal(deadlineFindings(source('src/maps/peak-markers.js','fetch(url)')).length,1);
    assert.equal(deadlineFindings(source('src/maps/other.ts',exception)).length,1);
    assert.deepEqual(deadlineFindings(source('src/maps/new.ts',"import {requestDeadline} from '../net/request-deadline.js'; fetch(url);")),[]);
    assert.equal(deadlineFindings(source('src/maps/new.ts','Promise.race([request, timeout])')).length,1);
});
