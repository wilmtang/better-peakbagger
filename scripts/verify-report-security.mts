// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createFixtureCertificate, projectRoot, waitForCondition as untypedWaitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import type { Driver as FirefoxDriver } from 'selenium-webdriver/firefox.js';
import { createVerificationRoot } from './verification-launch.mts';

const waitForCondition = untypedWaitForCondition as unknown as <T>(read: () => Promise<T>, options: { description: string; isReady: (value: T) => boolean }) => Promise<T>;
interface ReportState { flags: string[]; sanitized: boolean; safe: boolean | undefined; active: boolean; map: string | undefined }

export async function verifyReportSecurity(kind: string, { baseline = false } = {}) {
    assert(['chrome','firefox'].includes(kind), 'Choose chrome or firefox');
    assert(!baseline || kind === 'chrome', 'Baseline reproduction supports Chrome');
    const resources = createResourceStack();
    try {
        const root = await createVerificationRoot(resources, 'bpb-report-security-', 'security files');
        const certificate = await createFixtureCertificate({directory:root as never});
        assert.ok(certificate);
        const base = await readFile(path.join(projectRoot,'test/fixtures/pages/ascent-ignored-report.html'),'utf8');
        let providerRequests = 0, attackRequests = 0;
        const payload = '<script>document.documentElement.dataset.attackInline="ran";document.documentElement.dataset.attackCookie=document.cookie;</script>'
            + '<script type="module">document.documentElement.dataset.attackModule="ran";</script>'
            + '<script src="/security-attack.js"></script><img src="/missing" onerror="document.documentElement.dataset.attackEvent=\'ran\'">'
            + '<svg onload="document.documentElement.dataset.attackSvg=\'ran\'"></svg>'
            + '<iframe srcdoc="&lt;script&gt;parent.document.documentElement.dataset.attackFrame=\'ran\'&lt;/script&gt;"></iframe>'
            + '<iframe src="/security-frame"></iframe><form><input name="clobber" id="Form1"></form>'
            + '<a href="javascript:document.documentElement.dataset.attackLink=\'ran\'">Unsafe link</a>';
        const server = createServer(certificate, (request,response) => {
            const url = new URL(request.url || '/','https://www.peakbagger.com');
            const send = (body: string,headers={}) => {response.writeHead(200,{'content-type':'text/html',...headers});response.end(body);};
            if (request.headers.host?.startsWith('www.instagram.com')) {providerRequests++;return send('<p>Unexpected provider contact</p>');}
            if (url.pathname === '/search.aspx') return send('<html><body>Search fixture</body></html>');
            if (url.pathname === '/report/report.aspx') return send('<html><script>document.documentElement.dataset.nativeList="ready"</script><body>Native buddy list fixture</body></html>');
            if (url.pathname === '/missing') {response.writeHead(404);return response.end();}
            if (url.pathname.startsWith('/security-')) {attackRequests++;return send('<script>parent.document.documentElement.dataset.attackRemote="ran"</script>');}
            if (/mastermap\.aspx/i.test(url.pathname)) return send('<html><script>document.documentElement.dataset.nativeMap="ready"</script><body>Native map fixture</body></html>');
            if (url.searchParams.has('cf')) return send('<html><script>document.documentElement.dataset.challenge="ran"</script><body>Challenge fixture</body></html>',{'cf-mitigated':'challenge'});
            const native = '<form name="Form1"><input id="QuickSearchTB" name="QuickSearchTB" onkeypress="return SearchKeyPress(event)"><input type="button" id="QSButton" value="Search" onclick="DoQuickSearch()"></form>';
            const html = base.replace('<main>',native+'<main>').replace('src="about:blank"></iframe>','src="/map/MasterMap.aspx"></iframe>')
                .replace('Synthetic report text', payload+`<img src="https://www.instagram.com:${(server.address() as AddressInfo).port}/native-image">Safe report text`);
            return send(html);
        });
        resources.defer('security server',()=>closeServer(server));await listenServer(server,0,'127.0.0.1');
        const origin=`https://www.peakbagger.com:${(server.address() as AddressInfo).port}`;
        let navigate: (url: string) => Promise<unknown>,evaluate: <T>(fn: () => T) => Promise<T>,click: (selector: string) => Promise<unknown>,version: string;
        if (kind==='chrome') {
            // Loaded here so the Firefox path does not need Playwright installed.
            const {launchVerificationChrome,PEAKBAGGER_HOST_RULE}=await import('./verification-launch.mts');
            let source=path.join(projectRoot,'dist');
            if(baseline){source=path.join(root,'baseline');await cp(path.join(projectRoot,'dist'),source,{recursive:true});const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));delete manifest.declarative_net_request;await writeFile(path.join(source,'manifest.json'),JSON.stringify(manifest));}
            const context=await launchVerificationChrome(resources,'security Chrome',path.join(root,'profile'),{viewport:{width:1000,height:760},
                trustArgs:certificate.chromeTrustArgs,extension:source,hosts:[PEAKBAGGER_HOST_RULE,'www.instagram.com 127.0.0.1']});
            const registry=await context.newPage();await registry.goto('chrome://extensions-internals/');
            const extension=await registry.waitForFunction(()=>{try{return JSON.parse(document.body.innerText).find((x: {name: string; id: string})=>x.name==='Better Peakbagger');}catch{return false;}}).then(h=>h.jsonValue());
            const page=await context.newPage();await page.goto(`chrome-extension://${extension.id}/options/options.html`);
            navigate=url=>page.goto(url);evaluate=fn=>page.evaluate(fn) as Promise<never>;click=selector=>page.locator(selector).click();version=context.browser()!.version();
        } else {
            const {Builder,By}=await import('selenium-webdriver');const firefox=(await import('selenium-webdriver/firefox.js')).default;
            const prepared=await prepareFirefoxSource({temporaryRoot:root});resources.defer('security Firefox source',()=>prepared.cleanup());
            resources.defer('security Firefox processes',()=>stopOwnedFirefoxProcesses(root));
            const profile=path.join(root,'profile');await mkdir(profile);
            const options=new firefox.Options().addArguments('-headless', '-no-remote').setProfile(profile)
                .setPreference('network.dns.localDomains','www.peakbagger.com,www.instagram.com');
            options.setAcceptInsecureCerts(true);
            if(process.env.FIREFOX_BIN)options.setBinary(process.env.FIREFOX_BIN);
            const driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access',`--profile-root=${root}`)).build() as FirefoxDriver;
            resources.defer('security Firefox driver',()=>quitFirefoxDriver(driver,root));await driver.installAddon(prepared.sourceDir,true);
            navigate=url=>driver.get(url);evaluate=fn=>driver.executeScript(`return (${fn})();`) as Promise<never>;click=selector=>driver.findElement(By.css(selector)).click();version=(await driver.getCapabilities()).getBrowserVersion() as string;
        }
        const inspect=()=>evaluate((): ReportState=>({flags:Object.keys(document.documentElement.dataset).filter(k=>k.startsWith('attack')),
            sanitized:!!document.querySelector('[data-bpb-report-protected]'),safe:document.querySelector('[data-bpb-report-protected]')?.textContent?.includes('Safe report text'),
            active:!!document.querySelector('[data-bpb-report-protected] script,[data-bpb-report-protected] form,[data-bpb-report-protected] [onerror],[data-bpb-report-protected] [onload],[data-bpb-report-protected] iframe'),
            map:(document.getElementById('Gmap') as HTMLIFrameElement | null)?.contentDocument?.documentElement.dataset.nativeMap}));
        for(const route of ['/climber/ascent.aspx?aid=7654321','/climber/Ascent.aspx?aid=7654321','/climber/%61scent.aspx?aid=7654321']){
            await navigate(origin+route);
            const state=await waitForCondition(inspect,{description:'protected report and native map',isReady:v=>v.sanitized&&v.map==='ready'});
            assert.deepEqual(state.flags,[],'report-supplied script must never execute');assert(state.safe);assert.equal(state.active,false);
            assert.equal(providerRequests,0,'native Instagram resources must be blocked before contacting the provider');assert.equal(attackRequests,0);
        }
        await evaluate(()=>{(document.getElementById('QuickSearchTB') as HTMLInputElement).value='snow & ice';});await click('#QSButton');
        await waitForCondition(()=>evaluate(()=>window.location.href),{description:'packaged quick-search behavior',isReady:v=>new URL(v).pathname==='/search.aspx'&&new URL(v).searchParams.get('ss')==='snow & ice'});
        await navigate(origin+'/climber/ascent.aspx?cf=1');
        await waitForCondition(()=>evaluate(()=>document.documentElement.dataset.challenge),{description:'Cloudflare exception',isReady:v=>v==='ran'});
        await navigate(origin+'/report/report.aspx?r=b');
        await waitForCondition(()=>evaluate(()=>document.documentElement.dataset.nativeList),{description:'native list scripts',isReady:v=>v==='ready'});
        console.log(JSON.stringify({verification:'report-security',kind,version,hidden:true,viewport:[1000,760],cases:6,baseline,providerRequests,attackRequests}));
    } finally {await resources.dispose();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const [kind,...args]=process.argv.slice(2);assert(args.length<=1&&(!args.length||args[0]==='--baseline'),'Usage: verify-report-security.mts chrome|firefox [--baseline]');
    await verifyReportSecurity(kind,{baseline:args.includes('--baseline')});
}
