// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportRule } from './generate-report-protection.mts';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Builder } from 'selenium-webdriver';
import { By, Key } from 'selenium-webdriver';
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
    const flag = (name: string) => `document.documentElement.dataset.${name}='ran'`;
    const typeSource = `<math><script>${flag('typeMath')}</script><a href="javascript:void(0)">Data</a></math>`
        + `<svg><script type="module">${flag('typeSvgModule')}</script><script language="vbscript">${flag('typeSvgClassic')}</script>`
        + `<script type="application/json">${flag('typeSvgJson')}</script><script type="invalid">${flag('typeSvgInvalid')}</script>`
        + `<script type=" module ">${flag('typeSvgWrappedModule')}</script></svg>`
        + `<script type="module">${flag('typeHtmlModule')}</script><script nomodule>${flag('typeNomodule')}</script>`
        + `<script type="text/javascript; charset=utf-8">${flag('typeParameterized')}</script>`
        + `<script for="other" event="onclick">${flag('typeLegacyOther')}</script><script for="window" event="onscroll">${flag('typeLegacyScroll')}</script>`
        + `<script type=" module ">${flag('typeWrappedModule')}</script><script type=" ">${flag('typeWhitespace')}</script><noscript><script>${flag('typeNoscript')}</script></noscript>`;
    const attacks = `<script>${flag('noticeInline')};\n${'// A long original source line\n'.repeat(40)}</script>`
        + `<img src="/missing" onerror="${flag('noticeEvent')}"><script src="/notice-external.js"></script>`;
    let unexpectedRequests = 0;
    const server = createServer(certificate, (request, response) => {
        const requested = new URL(request.url!, 'https://www.peakbagger.com');
        if (['/notice-external.js','/srcdoc-resource.png'].includes(requested.pathname)) unexpectedRequests++;
        if (requested.searchParams.get('fixture') === 'types') { response.writeHead(200,{'content-type':'text/html'}); response.end('<!doctype html><html><body>'+typeSource+'</body></html>'); return; }
        if (requested.searchParams.get('fixture') === 'map') { response.writeHead(200, {'content-type':'text/html'}); response.end('<html><script>document.documentElement.dataset.nativeMap=\"ran\"</script><body>Native map fixture</body></html>'); return; }
        if (requested.searchParams.get('fixture') === 'report') {
            const variant = requested.searchParams.get('notice');
            const payload = variant === 'code' ? attacks : variant === 'types' ? typeSource
                : variant === 'many' ? Array.from({length:65},(_, index)=>`<script>example(${index})</script>`).join('')
                    : variant === 'limited' ? '<span></span>'.repeat(3001)
                        : variant === 'frame' ? '<iframe srcdoc="&lt;script&gt;frameCode()&lt;/script&gt;&lt;img src=&quot;/srcdoc-resource.png&quot;&gt;"></iframe>' : '';
            response.writeHead(200, { 'content-type': 'text/html' }); response.end(report.replace('Synthetic report text',payload+'Synthetic report text').replace('src=\"about:blank\"></iframe>', 'src=\"/map/' + (requested.searchParams.has('encoded-map') ? '%4dasterMap.aspx' : 'MasterMap.aspx') + '?fixture=map\"></iframe>')); return;
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
  let ui: (fn: () => unknown) => Promise<unknown>;
  let resize: (width:number,height:number) => Promise<unknown>;
  let pressKey: (selector:string,value:'Enter'|'Space') => Promise<unknown>;
  let screenshot: (target:string) => Promise<unknown>;
  let selectSecond: () => Promise<unknown>;
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
      ui = fn => page.evaluate(fn);
      resize = (width,height) => page.setViewportSize({width,height});
      pressKey = async (selector,value) => {await page.locator(selector).focus(); await page.locator(selector).press(value);};
      screenshot = target => page.screenshot({path:target,fullPage:true});
      selectSecond = () => page.locator('.bpb-rs-select').selectOption({index:1});
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
      // Classic scrollbars must not shrink the native report column when the
      // source disclosure makes a short page scroll. Override only this profile.
      options.setPreference('ui.useOverlayScrollbars', 0);
      if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
      const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
          .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access', `--profile-root=${temporaryRoot}`)).build() as firefox.Driver;
      owned.defer('audit Firefox driver', () => quitFirefoxDriver(driver, temporaryRoot));
      await driver.installAddon(prepared.sourceDir, true);
      await driver.manage().window().setRect({ width: 1000, height: 900 });
      navigate = url => driver.get(url);
      evaluate = fn => driver.executeScript(`return (${fn})();`);
      ui = fn => driver.executeScript(`return (${fn})();`);
      resize = (width,height) => driver.manage().window().setRect({width,height:height+85});
      pressKey = async (selector,value) => {
          const element = await driver.findElement(By.css(selector));
          const character = value==='Enter'?Key.ENTER:Key.SPACE;
          await element.sendKeys(character);
      };
      screenshot = async target => writeFile(target,await driver.takeScreenshot(),'base64');
      // The headless Gecko popup did not commit keyboard selection. Exercise
      // the native option path and retain that keyboard/popup proof gap.
      selectSecond = () => driver.findElement(By.css('.bpb-rs-select option:nth-child(2)')).click();
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
  await navigate(origin+'/climber/climber.aspx?fixture=types');
  const nativeTypes = await ui(() => Object.fromEntries(Object.entries(document.documentElement.dataset).filter(([name])=>name.startsWith('type'))));
  console.log(JSON.stringify({nativeTypes,kind}));
  console.log(JSON.stringify({typeSupport:await ui(() => ({wrapped:HTMLScriptElement.supports(' module '),raw:HTMLScriptElement.supports('module')}))}));
  assert.deepEqual(nativeTypes,{typeSvgClassic:'ran',typeSvgModule:'ran',typeHtmlModule:'ran',...(kind==='firefox'?{typeSvgWrappedModule:'ran',typeWrappedModule:'ran'}:{})},'native browser script-type behavior');
  const noticeUrl = (variant:string) => origin+'/climber/ascent.aspx?fixture=report&notice='+variant;
  const noticeReady = async (title:string) => wait(async () => await ui(() => document.querySelector('.bpb-rs-title')?.textContent),
      {description:'original-source notice '+title,isReady:value=>value===title});
  for (const [variant,title] of [['types',kind==='firefox'?'5 scripts blocked':'3 scripts blocked'],['many','Scripts blocked'],['limited','Script inspection limited'],['frame','1 script blocked']]) {
      await navigate(noticeUrl(variant)); await noticeReady(title);
      if (variant==='many') assert.equal(await ui(() => document.querySelectorAll('.bpb-rs-select option').length),64);
  }
  const geometry = () => ui(() => {
      const notice = document.querySelector<HTMLDetailsElement>('.bpb-rs-notice')!;
      const rectangle = (element:Element) => {const box=element.getBoundingClientRect();return [box.x+scrollX,box.y+scrollY,box.width,box.height];};
      return {summary:rectangle(notice.querySelector('summary')!),notice:rectangle(notice),
          title:rectangle(notice.previousElementSibling!),following:rectangle(notice.nextElementSibling!),
          scroll:[scrollX,scrollY],documentWidth:document.documentElement.scrollWidth,width:innerWidth,
          clientWidth:document.documentElement.clientWidth,documentHeight:document.documentElement.scrollHeight,
          focus:document.activeElement?.className,focusTag:document.activeElement?.tagName,
          activeSource:[...notice.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement),open:notice.open};
  });
  const layouts = [];
  if (process.env.BPB_REPORT_SCREENSHOTS) await mkdir(process.env.BPB_REPORT_SCREENSHOTS,{recursive:true});
  await navigate(noticeUrl('many')); await noticeReady('Scripts blocked');
  await pressKey('.bpb-rs-summary','Enter');
  await ui(() => document.querySelector<HTMLSelectElement>('.bpb-rs-select')!.focus());
  const selectBefore = await geometry();
  await selectSecond();
  const selectAfter = await geometry();
  if (kind === 'chrome') assert.deepEqual(selectAfter,selectBefore,'native source selector keeps geometry, scroll and focus');
  else {
      const {focus:beforeFocus,focusTag:beforeTag,...beforeLayout} = selectBefore as {focus:string;focusTag:string};
      const {focus:afterFocus,focusTag:afterTag,...afterLayout} = selectAfter as {focus:string;focusTag:string};
      assert.deepEqual(afterLayout,beforeLayout,'native Firefox option selection keeps report geometry and scroll');
      console.log(JSON.stringify({firefoxNativePickerFocus:{beforeFocus,beforeTag,afterFocus,afterTag},keyboardAndPopupFocus:'unverified in hidden automation'}));
  }
  assert.equal(await ui(() => document.querySelector<HTMLSelectElement>('.bpb-rs-select')!.selectedIndex),1);
  assert.match(String(await ui(() => document.querySelector('.bpb-rs-code')!.textContent)),/example\(1\)/);
  await ui(() => document.querySelector<HTMLSelectElement>('.bpb-rs-select')!.focus());
  const focusedBefore = await geometry();
  await ui(() => {
      const picker=document.querySelector<HTMLSelectElement>('.bpb-rs-select')!;
      picker.selectedIndex=2;picker.dispatchEvent(new Event('change',{bubbles:true}));
  });
  assert.deepEqual(await geometry(),focusedBefore,'source change handler preserves actual focused picker and layout');
  for (const width of [1000,kind==='firefox'?500:360]) for (const theme of ['light','dark']) for (const textScale of [1,2]) {
      await resize(width,760); await navigate(noticeUrl('code')); await noticeReady('3 scripts blocked');
      // Explicit text-enlargement check; this is not browser chrome zoom.
      await ui(theme==='dark' ? () => {document.documentElement.dataset.bpbTheme='dark';} : () => {document.documentElement.dataset.bpbTheme='light';});
      await ui(textScale===2 ? () => {document.querySelector<HTMLElement>('.bpb-rs-notice')!.style.fontSize='26px';} : () => {});
      const closed = await geometry() as {summary:number[];open:boolean;width:number;clientWidth:number}; assert.equal(closed.open,false);
      assert.equal(closed.width,width,'verify actual content viewport, including Firefox minimum window size');
      if (process.env.BPB_REPORT_SCREENSHOTS && theme==='light' && textScale===1) {
          await screenshot(path.join(process.env.BPB_REPORT_SCREENSHOTS,`${kind}-${width}-closed.png`));
      }
      await pressKey('.bpb-rs-summary','Enter');
      const opened = await geometry() as {summary:number[];open:boolean;clientWidth:number}; assert(opened.open);
      assert.deepEqual(opened.summary,closed.summary,`disclosure trigger stays anchored; viewport before=${closed.clientWidth}, after=${opened.clientWidth}`);
      assert.equal(opened.clientWidth,closed.clientWidth,'opening the disclosure preserves the available page width');
      await pressKey('.bpb-rs-choice:nth-child(3)','Enter');
      await ui(() => document.querySelector<HTMLButtonElement>('.bpb-rs-choice:nth-child(1)')!.click());
      const before = await geometry();
      await pressKey('.bpb-rs-choice:nth-child(3)','Space');
      const after = await geometry();
      assert.deepEqual(after,before,'source selection must not move report, controls, reading position or focus');
      assert.equal((after as {documentWidth:number}).documentWidth,(after as {clientWidth:number}).clientWidth,'inspector does not create horizontal overflow');
      assert.equal(await ui(() => [...document.querySelectorAll('.bpb-rs-choice')].every(button=>getComputedStyle(button).borderBottomWidth==='2px')),true,'native dark theme preserves source selection rules');
      assert.match(String(await ui(() => document.querySelector('.bpb-rs-code')!.textContent)),/External file contents are not available/);
      assert.equal(await ui(() => document.querySelectorAll('.bpb-rs-notice script,.bpb-rs-notice img').length),0);
      assert.deepEqual(await ui(() => Object.keys(document.documentElement.dataset).filter(name=>name.startsWith('notice'))),[]);
      layouts.push({width,theme,textScale,...after as object});
      if (process.env.BPB_REPORT_SCREENSHOTS) {
          await screenshot(path.join(process.env.BPB_REPORT_SCREENSHOTS,`${kind}-${width}-${theme}${textScale===2?'-text2':''}.png`));
      }
      await pressKey('.bpb-rs-summary','Space');
      const closedAgain = await geometry() as {summary:number[];open:boolean}; assert.equal(closedAgain.open,false);
      assert.deepEqual(closedAgain.summary,closed.summary);
  }
  assert.equal(layouts.length,8); assert.equal(unexpectedRequests,0,'inspection must not fetch external scripts or srcdoc resources');
  console.log(JSON.stringify({verification:'report-routes',kind,version,hidden:true,temporaryRoot,certificateRoot:certificate.root,cases,layouts,nativeTypes,unexpectedRequests,nativePickerKeyboard:'unverified in hidden automation',fullGpxChartAndProviderPlayback:'not exercised'}));
} finally { await owned.dispose(); }
