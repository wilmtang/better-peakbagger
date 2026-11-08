// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportRule } from './generate-report-protection.mts';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { assertVerificationBrowser } from './verification-browser-identity.mjs';

const kind = process.argv[2] || '';
assert.ok(['chrome', 'firefox'].includes(kind) && process.argv.length === 3, 'Choose chrome or firefox');
const root = fileURLToPath(new URL('../', import.meta.url));
const owned = createResourceStack();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bpb-report-policy-audit-'));
owned.defer('audit profile/certificate', () => rm(temporaryRoot, { recursive: true, force: true }));
const wait = waitForCondition as <T>(read: () => Promise<T>, options: { description: string; isReady: (value: T) => boolean; timeoutMs?: number }) => Promise<T>;
try {
    const certificate = await createFixtureCertificate();
    assert.ok(certificate, 'fixture certificate must be available');
    owned.defer('audit certificate', () => certificate.remove());
    const base = await readFile(path.join(root, 'test/fixtures/pages/ascent-ignored-report.html'), 'utf8');
    const benignScript = '<script>document.documentElement.dataset.safeInline="ran";</script>';
    const report = base.replace('</head>', benignScript + '</head>').replace('Synthetic report text',
        '<pre><code>&lt;script&gt;exampleOnly()&lt;/script&gt;</code></pre>'
    + '<script type="application/json">{"safe":"data only"}</script>'
    + '<audio src="/audio.ogg" controls></audio>'
    + 'Synthetic report text');
    const server = createServer(certificate, (request, response) => {
        const requested = new URL(request.url!, 'https://www.peakbagger.com');
        if (requested.searchParams.get('fixture') === 'map') { response.writeHead(200, {'content-type':'text/html'}); response.end('<html><script>document.documentElement.dataset.nativeMap=\"ran\"</script><body>Native map fixture</body></html>'); return; }
        if (requested.searchParams.get('fixture') === 'report') {
            response.writeHead(200, { 'content-type': 'text/html' }); response.end(report.replace('src=\"about:blank\"></iframe>', 'src=\"/map/' + (requested.searchParams.has('encoded-map') ? '%4dasterMap.aspx' : 'MasterMap.aspx') + '?fixture=map\"></iframe>')); return;
        }
        if (requested.searchParams.get('fixture') === 'profile') {
            response.writeHead(200, { 'content-type': 'text/html', ...(requested.searchParams.has('cf') ? {'cf-mitigated':'challenge'} : {}) });
            const mapPath = requested.searchParams.get('map-case') || '';
            const allowedFixtures = ['/map/%4dasterMap.aspx', '/x/%4dasterMap.aspx', '/ma/%4dasterMap.aspx', '/mapx/%4dasterMap.aspx'];
            const frame = allowedFixtures.includes(mapPath) ? `<iframe id="Gmap" src="${mapPath}?fixture=map"></iframe>` : '';
            response.end('<!doctype html><html><head>' + benignScript + '</head><body><h1>Benign profile fixture</h1>' + frame + '</body></html>'); return;
        }
        response.writeHead(404); response.end();
    });
    owned.defer('audit HTTPS server', () => closeServer(server));
    await listenServer(server, 0, '127.0.0.1');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `https://www.peakbagger.com:${address.port}`;
  type State = { native: string | null; discovery: boolean; registryTag: string; localInstanceof: boolean; symbolNames: string[]; leafletHook: boolean; chart: string; protected: boolean; code: string | null; jsonRetained: boolean; audioRetained: boolean; width: number; height: number; ready: string; map: string | null };
  let navigate: (url: string) => Promise<unknown>;
  let evaluate: (fn: () => State) => Promise<State>;
  let version: string;
  if (kind === 'chrome') {
      assertChromeLaunchAllowed();
      const source = path.join(root, 'dist');
      const context = await chromium.launchPersistentContext(path.join(temporaryRoot, 'profile'), {
          ...(process.env.CHROME_BIN ? {executablePath:path.resolve(process.env.CHROME_BIN)} : {channel:'chromium'}),
          headless: true, viewport: { width: 1000, height: 760 }, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
          args: [...certificate.chromeTrustArgs, `--disable-extensions-except=${source}`, `--load-extension=${source}`, '--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1'],
      });
      owned.defer('audit Chrome', () => context.close());
      const registry = await context.newPage(); await registry.goto('chrome://extensions-internals/');
      await registry.waitForFunction(() => { try { return JSON.parse(document.body.innerText).some((entry: { name: string }) => entry.name === 'Better Peakbagger'); } catch { return false; } });
      const page = await context.newPage();
      const compiled = JSON.parse(await readFile(path.join(root, 'dist/rules/report-protection.json'), 'utf8')) as ReportRule[];
      const extension = await registry.evaluate(() => JSON.parse(document.body.innerText).find((entry: {name:string}) => entry.name === 'Better Peakbagger'));
      await page.goto(`chrome-extension://${extension.id}/options/options.html`);
      const supports = await page.evaluate(async rules => {
          const api = (globalThis as typeof globalThis & {chrome:{declarativeNetRequest:{isRegexSupported:(options:{regex:string;isCaseSensitive:boolean;requireCapturing:boolean})=>Promise<{isSupported:boolean;reason?:string}>}}}).chrome.declarativeNetRequest;
          return await Promise.all(rules.map(async rule => ({id:rule.id,...await api.isRegexSupported({regex:rule.condition.regexFilter,isCaseSensitive:rule.condition.isUrlFilterCaseSensitive,requireCapturing:false})})));
      }, compiled);
      assert.ok(supports.length > 0); assert.deepEqual(supports.filter(rule => !rule.isSupported), [], 'packaged regexes must compile');
      navigate = url => page.goto(url);
      evaluate = fn => page.evaluate(fn);
      version = context.browser()!.version();
      assertVerificationBrowser({name:context.browser()!.browserType().name(),version,expectedName:'chromium',expectedVersion:process.env.BPB_EXPECT_CHROME_VERSION});
  } else {
      const prepared = await prepareFirefoxSource({ temporaryRoot });
      owned.defer('audit Firefox package', () => prepared.cleanup());
      owned.defer('audit Firefox processes', () => stopOwnedFirefoxProcesses(temporaryRoot));
      const profile = path.join(temporaryRoot, 'profile'); await mkdir(profile);
      const options = new firefox.Options().addArguments('-headless').setProfile(profile);
      options.setAcceptInsecureCerts(true);
      options.setPreference('network.dns.localDomains', 'www.peakbagger.com');
      if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
      const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
          .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`)).build() as firefox.Driver;
      owned.defer('audit Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
      await driver.installAddon(prepared.sourceDir, true);
      await driver.manage().window().setRect({ width: 1000, height: 900 });
      navigate = url => driver.get(url);
      evaluate = fn => driver.executeScript(`return (${fn})();`);
      const detected = (await driver.getCapabilities()).getBrowserVersion(); assert.ok(detected); version = detected;
      assertVerificationBrowser({name:(await driver.getCapabilities()).getBrowserName(),version,expectedName:'firefox',expectedVersion:process.env.BPB_EXPECT_FIREFOX_VERSION});
  }
  const inspect = () => evaluate(() => {
      const win = window as typeof window & { Chart?: unknown; [key: symbol]: unknown };
      const cell = document.querySelector('[data-bpb-report-protected]');
      const symbols = Object.getOwnPropertySymbols(win);
      const registryKey = symbols.find(key => key.description === 'bpb.leafletMaps') || win.Symbol.for('bpb.leafletMaps');
      const registry = win[registryKey];
      const descriptor = Object.getOwnPropertyDescriptor(win, 'L');
      return { native: document.documentElement.dataset.safeInline || null,
          discovery: Object.prototype.toString.call(registry) === '[object Set]', registryTag: Object.prototype.toString.call(registry),
          localInstanceof: registry instanceof Set, symbolNames: symbols.map(key => key.description || ''),
          leafletHook: typeof descriptor?.get === 'function' && typeof descriptor?.set === 'function', chart: typeof win.Chart, protected: !!cell,
          code: cell?.querySelector('pre code')?.textContent || null,
          jsonRetained: !!cell?.querySelector('script[type="application/json"]'), audioRetained: !!cell?.querySelector('audio'),
          width: window.innerWidth, height: window.innerHeight, ready:document.readyState,
          map:document.querySelector<HTMLIFrameElement>('#Gmap')?.contentDocument?.documentElement.dataset.nativeMap || null };
  });
  const cases = [];
  const routes: {path:string;block:boolean;credentials?:boolean;report?:boolean;encodedMap?:boolean;challenge?:boolean;mapPath?:string;mapAllowed?:boolean}[] = [
      {path:'/climber/climber.aspx',block:false},
      {path:'/climber/%63limber.aspx',block:false},
      {path:'/climber/%63limber.aspx',block:false,credentials:true},
      {path:'/%63limber/%61scentedit%2easpx',block:false},
      {path:'/cl/ascent.aspx',block:false}, {path:'/climberx/ascent.aspx',block:false},
      {path:'/climber/ascent.aspxevil',block:false}, {path:'/climber/ascent.aspx%65vil',block:false},
      {path:'/climber/climber.aspx?return=%25%00',block:false},
      {path:'/climber/ascent.aspx',block:true,report:true},
      {path:'/climber/ascent.aspx',block:true,report:true,credentials:true},
      {path:'/climber/%61scent.aspx',block:true,report:true},
      {path:'/%63limber/%41scent%2easpx',block:true,report:true},
      {path:'/climber/ascent.aspx;extra',block:true,report:true},
      {path:'/climber/ascent.aspx.',block:true,report:true},
      {path:'/climber/ascent.aspx',block:true,report:true,encodedMap:true},
      {path:'/climber/%2561scent.aspx',block:true},
      {path:'/climber%2fascent.aspx',block:true},
      {path:'/%252e%252e/profile.aspx',block:true},
      {path:'/climber/climber.aspx%00',block:true},
      {path:'/climber/climber.aspx%2e',block:true},
      {path:'/climber/ascent.aspx%2e.',block:true},
      {path:'/climber/ascent.aspx.%2e./extra',block:true},
      {path:'/%63limber./ascent.aspx',block:true},
      {path:'/climber./%61scent.aspx',block:true},
      {path:'/climber/%25foo.aspx',block:false,challenge:true},
      ...['/map/%4dasterMap.aspx', '/x/%4dasterMap.aspx', '/ma/%4dasterMap.aspx', '/mapx/%4dasterMap.aspx']
          .map(mapPath => ({path:'/climber/climber.aspx',block:false,mapPath,mapAllowed:mapPath.startsWith('/map/')})),
  ];
  for(const item of routes) {
      const url=new URL(origin+item.path); url.searchParams.set('fixture',item.report?'report':'profile');
      if(item.credentials) { url.username='fixture.user'; url.password='fixture.pass'; }
      if(item.mapPath) url.searchParams.set('map-case',item.mapPath);
      if(item.encodedMap) url.searchParams.set('encoded-map','1'); if(item.challenge) url.searchParams.set('cf','1');
      await navigate(url.href);
      const state=await wait(inspect,{description:'fixture document, BPB startup and permitted native map',isReady:value=>value.ready==='complete'
      && (!item.report||(value.protected&&value.map==='ran'&&value.discovery))
      && (item.path!=='/climber/ascent.aspx'||value.chart==='function')
      && (!('mapAllowed' in item)||!item.mapAllowed||value.map==='ran')});
      assert.equal(state.native,item.block?null:'ran', `${kind} route policy ${item.path}`);
      if('mapAllowed' in item) assert.equal(state.map,item.mapAllowed?'ran':null,'inverse map-folder priority '+item.mapPath);
      if(item.report) { assert.ok(state.discovery); assert.match(state.code!,/<script>exampleOnly\(\)<\/script>/); }
      if(item.path==='/climber/ascent.aspx') assert.equal(state.chart,'function','BPB MAIN-world Chart vendor loads under report policy');
      cases.push({path:item.path,...state});
  }
  assert.equal(cases.length,routes.length); assert.ok(cases.length>0);
  console.log(JSON.stringify({verification:'report-routes',kind,version,hidden:true,temporaryRoot,certificateRoot:certificate.root,cases,fullGpxChartAndProviderPlayback:'not exercised'}));
} finally { await owned.dispose(); }
