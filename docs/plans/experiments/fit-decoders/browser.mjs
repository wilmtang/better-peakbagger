// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
// Hidden browser Worker checks. Does not install or modify the extension.
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';
import { assertChromeLaunchAllowed } from '../../../../scripts/chrome-launch-guard.mjs';
import { createFixtureCertificate } from '../../../../scripts/browser-verification-fixtures.mjs';
import { fixtures, matches } from './fixtures.mjs';
import { summarize } from './projection.mjs';

assert.equal(process.argv.length, 3, 'Usage: node browser.mjs /absolute/temporary-evaluation-root');
assertChromeLaunchAllowed();
const root = path.resolve(process.argv[2]);
const here = path.dirname(fileURLToPath(import.meta.url));
const nodeResults = JSON.parse(await readFile(path.join(root, 'results.json')));
const manifest = JSON.parse(await readFile(path.join(root, 'corpus-manifest.json')));
const bundles = new Map();
const report = { bundles: {}, browsers: [] };
const imports = {
    raw: `import {readFitMessages} from ${JSON.stringify(path.join(root, 'node_modules/fit-file-parser/dist/raw-message-reader.js'))};
        const decode = bytes => projectRaw(readFitMessages(bytes, {messageNumbers:[0,18,19,20,21,34],maxInputBytes:8388608}));`,
    full: `import FitParser from ${JSON.stringify(path.join(root, 'node_modules/fit-file-parser/dist/fit-parser.js'))};
        const decode = async bytes => projectSemantic((await new FitParser({force:false,strict:true}).parseAsync(bytes)).records ?? []);`,
    decoder: `import candidate from ${JSON.stringify(path.join(root, 'node_modules/fit-decoder/dist/index.js'))};
        const decode = bytes => projectSemantic(candidate.parseRecords(candidate.fit2json(bytes)).records.filter(r=>r.type==='record').map(r=>r.data));`,
};
for (const [name, source] of Object.entries(imports)) {
    const result = await build({ stdin: { contents: `import {projectRaw,projectSemantic} from './projection.mjs';
        ${source}
        console.log=()=>{};
        self.onmessage=async ({data})=>{try{self.postMessage({ok:true,points:await decode(data)});}
          catch(error){self.postMessage({ok:false,error:String(error.message??error).slice(0,180)});}};`,
        resolveDir: here, sourcefile: `${name}-worker.mjs` }, bundle: true, minify: true, write: false,
        platform: 'browser', format: 'iife', target: ['chrome120', 'firefox121'], metafile: true });
    const code = result.outputFiles[0].contents;
    bundles.set(`/${name}.js`, code);
    report.bundles[name] = { minifiedBytes: code.length, gzipBytes: gzipSync(code).length,
        inputs: Object.keys(result.metafile.inputs).map(p => {
            const absolute = path.resolve(p);
            return absolute.startsWith(`${root}/`) ? absolute.replace(root, '<temporary-packages>') : p;
        }) };
}
const certificate = await createFixtureCertificate({ label: 'fit-decoder-evaluation' });
const server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html',
            'content-security-policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'" });
        response.end('<!doctype html><title>FIT worker evaluation</title>');
    } else if (bundles.has(request.url)) {
        response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bundles.get(request.url));
    } else { response.writeHead(404); response.end(); }
});
const browsers = [];
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    for (const name of ['chromium', 'firefox']) {
        const browser = name === 'chromium'
            ? await chromium.launch({ channel: 'chromium', headless: true,
                ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
                args: ['--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1', ...certificate.chromeTrustArgs] })
            : await firefox.launch({ headless: true, firefoxUserPrefs: { 'network.dns.localDomains': 'www.peakbagger.com' } });
        browsers.push(browser);
        const page = await browser.newPage({ viewport: { width: 800, height: 600 }, ignoreHTTPSErrors: name === 'firefox' });
        await page.goto(`https://www.peakbagger.com:${server.address().port}/`);
        const result = { name, version: browser.version(), syntheticExecutions: 0, corpusExecutions: 0 };
        async function decode(candidate, bytes) {
            return page.evaluate(async ({ candidate, bytes }) => {
                const worker = new Worker(`/${candidate}.js`);
                let timer;
                try {
                    return await new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Worker timeout')), 5000);
                        worker.onerror = event => reject(new Error(event.message));
                        worker.onmessage = event => resolve(event.data);
                        const buffer = Uint8Array.from(bytes).buffer;
                        worker.postMessage(buffer, [buffer]);
                    });
                } finally { clearTimeout(timer); worker.terminate(); }
            }, { candidate, bytes: [...bytes] });
        }
        for (const candidate of Object.keys(imports)) {
            for (const fixture of fixtures()) {
                const actual = await decode(candidate, fixture.bytes);
                const pass = fixture.reject ? !actual.ok : actual.ok && matches(actual.points, fixture.expected);
                const expected = nodeResults.synthetic.find(row => row.name === fixture.name)[candidate];
                assert.equal(actual.ok, expected.ok, `${name}/${candidate}/${fixture.name} acceptance changed`);
                assert.equal(pass, expected.pass, `${name}/${candidate}/${fixture.name} values changed`);
                result.syntheticExecutions++;
            }
            for (const item of manifest) {
                const actual = await decode(candidate, await readFile(path.join(root, 'corpus', item.file)));
                const expected = nodeResults.corpus.find(row => row.file === item.file)[candidate];
                assert.equal(actual.ok, expected.ok, `${name}/${candidate}/${item.file} acceptance changed`);
                if (actual.ok) assert.deepEqual(summarize(actual.points), expected.summary);
                result.corpusExecutions++;
            }
        }
        report.browsers.push(result);
        console.log(`${name} ${result.version}: ${result.syntheticExecutions} synthetic + ${result.corpusExecutions} public Worker executions matched Node outcomes.`);
        await page.close();
    }
    await writeFile(path.join(root, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report.bundles, (key, value) => key === 'inputs' ? undefined : value));
} finally {
    const errors = [];
    for (const browser of browsers.reverse()) { try { await browser.close(); } catch (error) { errors.push(error); } }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await certificate.remove();
    await assert.rejects(access(certificate.root));
    if (errors.length) throw new AggregateError(errors, 'Browser teardown failed');
}
