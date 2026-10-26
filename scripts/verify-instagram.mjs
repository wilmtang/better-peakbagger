// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* global document, window, ClipboardEvent, DataTransfer */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { projectRoot, createFixtureCertificate, waitForCondition } from './browser-verification-fixtures.mjs';
import { createResourceStack, listenServer, closeServer } from './resource-stack.mjs';
import { assertChromeLaunchAllowed } from './chrome-launch-guard.mjs';
import { prepareFirefoxSource } from './run-firefox.mjs';
import { quitFirefoxDriver, stopOwnedFirefoxProcesses } from './firefox-verifier-processes.mjs';
import { setFirefoxContentViewport } from './firefox-content-viewport.mjs';
import { readSettingsFragmentLanding, settingsFragmentLanded } from './settings-fragment-verification.mjs';
import { canonicalInstagramUrl } from '../src/reports/instagram-url.js';
import { verifyReportImageHelp } from './verify-report-image-help.mjs';

const POST='https://www.instagram.com/p/fA9uwTtkSN/';
// Public sample linked by its author: https://www.nps.gov/media/video/view.htm?id=0C5D889A-6097-4041-B8A2-E9CFE6C0E554
const REEL='https://www.instagram.com/reel/C8W_bpOJMGK/';
// Mixed photo/video carousel from the reported saved ascent (aid=2019756).
const CAROUSEL='https://www.instagram.com/p/Cis30nUPJSJ/';
const OTHER='https://www.instagram.com/reel/Fixture_Reel/';
const CARD='.bpb-instagram';
const ACTION=`${CARD} .bpb-instagram-action`;
const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
function readPlayer() {
    const visible=node=>{const r=node.getBoundingClientRect();return r.width>150&&r.height>150&&r.right>1&&r.x<window.innerWidth-1;};
    const items=[...document.querySelectorAll('ul>li')];
    return {title:document.title,text:document.body.innerText.slice(0,200),
        captionLength:document.querySelector('.Caption')?.textContent.trim().length||0,
        captionBottom:document.querySelector('.Caption')?.getBoundingClientRect().bottom,viewportHeight:window.innerHeight,
        parentBlocked:document.body.dataset.parentBlocked,topBlocked:document.body.dataset.topBlocked,
        popupBlocked:document.body.dataset.popupBlocked,navigationBlocked:document.body.dataset.navigationBlocked,
        playerError:document.body.dataset.playerError,extensionApi:document.body.dataset.extensionApi,
        images:[...document.images].filter(i=>visible(i)&&i.naturalWidth>0).length,
        videos:[...document.querySelectorAll('video')].filter(visible).map(v=>({ready:v.readyState,width:v.videoWidth,
            time:v.currentTime,frames:v.getVideoPlaybackQuality?.().totalVideoFrames||0})),
        carousel:{slides:items.length,index:items.findIndex(i=>Math.abs(i.getBoundingClientRect().x)<=1)}};
}
function stable(before,after,{expanded=false}={}) {
    for(const key of ['button','heading','card'])for(const axis of ['x','y','width',...(key==='card'&&expanded?[]:['height'])])
        assert(Math.abs(before[key][axis]-after[key][axis])<=1,`${key}.${axis} shifted: ${JSON.stringify({before,after})}`);
    if(!expanded)assert(Math.abs(before.following.y-after.following.y)<=1,`following prose moved: ${JSON.stringify({before,after})}`);
    assert(Math.abs(before.scroll-after.scroll)<=1,'reading position moved');
}

export async function verifyInstagram(kind,{live=false,screenshots}={}) {
    assert(['chrome','firefox'].includes(kind),'Choose chrome or firefox');
    const livePosts=[POST,REEL,CAROUSEL];
    if(live&&process.env.BPB_INSTAGRAM_LIVE_POST){const url=canonicalInstagramUrl(process.env.BPB_INSTAGRAM_LIVE_POST);assert(url,'Invalid live post URL');livePosts.push(url);}
    const resources=createResourceStack();
    try {
        const root=await mkdtemp(path.join(tmpdir(),'bpb-instagram-'));
        resources.defer('Instagram files',()=>rm(root,{recursive:true,force:true}));
        const certificate=await createFixtureCertificate({directory:root});
        let saved=await readFile(path.join(projectRoot,'test/fixtures/pages/ascent-ignored-report.html'),'utf8');
        saved=saved.replace(/<figure>[\s\S]*?<\/iframe>/,'')
            // Faithful native report shape: abbreviated hostname labels and
            // <br> separators, plus the same post in the external-report field.
            .replace('<a href="https://example.com/report">External report</a>',`<a href="${POST}?igshid=fixture">instagram.com</a>`)
            .replace('Synthetic report text',`Before the post.<br><br><a href="${POST}?igshid=fixture">www.instagram.com</a><br><br>After the post.<br><br><a href="${OTHER}">instagram.com</a><br><br>Following report text`)
            .replace('</main>','<div id="following" style="clear:both">Following native content</div></main>');
        const edit=await readFile(path.join(projectRoot,'test/fixtures/pages/climber-ascentedit.html'),'utf8');
        const video=await readFile(path.join(projectRoot,'store-assets/showcase-activity-capture.mp4'));
        let held=true,requests=0,connects=0,videoLoads=0,formSubmissions=0;const waiting=new Set(),sockets=new Set();
        const provider=(response)=>{
            response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
            response.end('<html><head><meta name="viewport" content="width=device-width"></head><body style="font:16px system-ui;margin:16px"><h2>Fixture Instagram post</h2><p>Provider content</p>'
                +(response.bpbCaptioned?'<p class="Caption">An author caption, included by the provider after loading.</p>':'')
                +'<button aria-label="Next">Next slide</button><div id="fixture-player"></div>'
                +'<script>try{parent.document.body;document.body.dataset.parentBlocked="no"}catch{document.body.dataset.parentBlocked="yes"}'
                +'try{top.document.cookie;document.body.dataset.topBlocked="no"}catch{document.body.dataset.topBlocked="yes"}'
                +'document.body.dataset.extensionApi=typeof chrome!=="undefined"&&!!chrome.runtime?"yes":"no";'
                +'document.querySelector("button").onclick=async()=>{'
                +'try{top.location.href="https://www.peakbagger.com/escape";document.body.dataset.navigationBlocked="no"}catch{document.body.dataset.navigationBlocked="yes"}'
                +'try{document.body.dataset.popupBlocked=window.open("https://www.instagram.com/escape")?"no":"yes"}catch{document.body.dataset.popupBlocked="yes"}'
                +'const form=document.createElement("form");form.action="https://www.instagram.com/fixture-form";document.body.append(form);form.requestSubmit();'
                +'try{const response=await fetch("https://www.instagram.com/fixture-video-source");if(!response.ok)throw Error("video loader");'
                +'const video=document.createElement("video");video.src=(await response.json()).src;video.muted=true;video.controls=true;video.loop=true;video.style.width="400px";video.style.maxWidth="100%";'
                +'document.getElementById("fixture-player").replaceChildren(video);await video.play();}catch(error){document.body.dataset.playerError=error.message}};'
                +'parent.postMessage(JSON.stringify({type:"MEASURE",details:{height:620}}),"*")</script></body></html>');
        };
        const server=httpsServer(certificate,(request,response)=>{
            const send=body=>{response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});response.end(body);};
            if(request.headers.host?.startsWith('www.instagram.com')){
                // No CORS allow header: an opaque/null-origin video loader must
                // fail here, as Instagram's real lazy-player endpoint does.
                if(request.url==='/fixture-video-source'){videoLoads++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({src:'https://www.instagram.com/fixture-video.mp4'}));return;}
                if(request.url==='/fixture-video.mp4'){response.writeHead(200,{'content-type':'video/mp4'});response.end(video);return;}
                if(request.url.startsWith('/fixture-form')){formSubmissions++;response.writeHead(204);response.end();return;}
                response.bpbCaptioned=request.url.split('?')[0].endsWith('/embed/captioned/');
                requests++;if(held){waiting.add(response);response.on('close',()=>waiting.delete(response));}else provider(response);return;
            }
            if(request.url.startsWith('/climber/ascentedit.aspx'))return send(edit);
            if(request.url.startsWith('/climber/ascent.aspx')){
                const index=Number(new URL(request.url,'https://www.peakbagger.com').searchParams.get('sample')||0);
                return send(saved.replaceAll(POST,livePosts[index]||POST));
            }
            if(request.url.startsWith('/other'))return send('<html><body>Other page</body></html>');
            response.writeHead(404);response.end();
        });
        resources.defer('Instagram fixture',()=>closeServer(server));await listenServer(server,0,'127.0.0.1');
        const proxy=httpServer((request,response)=>{response.writeHead(403);response.end();});
        proxy.on('connect',(request,socket,head)=>{
            socket.on('error',()=>{});
            const destination=new URL('https://'+request.url);
            const allowed=destination.port===''&&(destination.hostname==='www.instagram.com'||live&&/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(destination.hostname));
            if(!allowed){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
            connects++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
            const remote=live?connect(443,destination.hostname):connect(server.address().port,'127.0.0.1');
            sockets.add(remote);remote.on('close',()=>sockets.delete(remote));remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());
            remote.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);});
        });
        resources.defer('Instagram proxy',async()=>{for(const socket of sockets)socket.destroy();await closeServer(proxy);});
        await listenServer(proxy,0,'127.0.0.1');
        const origin=`https://www.peakbagger.com:${server.address().port}`;
        const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
        let evaluate,control,navigate,click,key,type,back,viewport,screenshot,optionsShot,version,player,play,hover,press,nextSlide;
        if(kind==='chrome') {
            const {chromium}=await import('playwright');assertChromeLaunchAllowed();
            const source=path.join(projectRoot,'dist');
            const context=await chromium.launchPersistentContext(path.join(root,'profile'),{channel:'chromium',headless:true,viewport:{width:1000,height:900},
                proxy:{server:proxyUrl,bypass:'www.peakbagger.com,127.0.0.1,localhost'},
                args:[...certificate.chromeTrustArgs,`--disable-extensions-except=${source}`,`--load-extension=${source}`,'--host-resolver-rules=MAP www.peakbagger.com 127.0.0.1']});
            resources.defer('Instagram Chrome',()=>context.close());
            const registry=await context.newPage();await registry.goto('chrome://extensions-internals/');
            const extension=await registry.waitForFunction(()=>{try{return JSON.parse(document.body.innerText).find(x=>x.name==='Better Peakbagger');}catch{return false;}}).then(h=>h.jsonValue());
            const options=await context.newPage();await options.goto(`chrome-extension://${extension.id}/options/options.html`);
            const page=await context.newPage();
            evaluate=(fn,arg)=>page.evaluate(fn,arg);control=(fn,arg)=>options.evaluate(fn,arg);navigate=url=>page.goto(url);
            click=selector=>page.locator(selector).first().click();key=async value=>{await page.locator(ACTION).first().focus();await page.keyboard.press(value);};
            hover=selector=>page.locator(selector).first().hover();press=value=>page.keyboard.press(value);
            type=async(selector,text)=>{await page.locator(selector).click();await page.keyboard.press('End');await page.keyboard.type(text);};back=()=>page.goBack();
            viewport=size=>page.setViewportSize(size);screenshot=file=>page.screenshot({path:file,fullPage:false});version=context.browser().version();
            optionsShot=async(width,file)=>{
                await options.setViewportSize({width,height:900});await options.goto(options.url().split('#')[0]+'#capture-report');await options.reload();
                await waitForCondition(()=>options.evaluate(readSettingsFragmentLanding),{description:'Report editor settings landing',isReady:value=>settingsFragmentLanded(value,'#capture-report')});
                await options.evaluate(()=>document.getElementById('load-instagram-automatically').closest('.row').scrollIntoView({block:'center'}));
                if(file)await options.screenshot({path:file});return {width,height:900};};
            player=async()=>{const outer=page.frames().find(f=>f.url().includes('/reports/instagram.html'));const inner=outer?.childFrames()[0];
                return inner?.evaluate(readPlayer);};
            nextSlide=async()=>{const inner=page.frames().find(f=>f.url().includes('/reports/instagram.html'))?.childFrames()[0];await inner.locator('[aria-label="Next"]').click();};
            play=async()=>{const inner=page.frames().find(f=>f.url().includes('/reports/instagram.html'))?.childFrames()[0];
                await inner.locator('video').evaluate(video=>{video.muted=true;});
                await inner.locator('[aria-label="Control"]').click();};
        } else {
            const {Builder,By,Key}=await import('selenium-webdriver');const firefox=(await import('selenium-webdriver/firefox.js')).default;
            const prepared=await prepareFirefoxSource({temporaryRoot:root});resources.defer('Instagram Firefox source',()=>prepared.cleanup());resources.defer('Instagram Firefox processes',()=>stopOwnedFirefoxProcesses(root));
            const profile=path.join(root,'profile');await mkdir(profile);
            const options=new firefox.Options().addArguments('-headless').enableBidi().setProfile(profile).setAcceptInsecureCerts(true)
                .setPreference('network.dns.localDomains','www.peakbagger.com').setPreference('network.proxy.type',1)
                .setPreference('network.proxy.ssl','127.0.0.1').setPreference('network.proxy.ssl_port',proxy.address().port)
                .setPreference('network.proxy.no_proxies_on','www.peakbagger.com,127.0.0.1,localhost');
            if(process.env.FIREFOX_BIN)options.setBinary(process.env.FIREFOX_BIN);
            const driver=await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access',`--profile-root=${root}`)).build();
            resources.defer('Instagram Firefox driver',()=>quitFirefoxDriver(driver,root));const addon=await driver.installAddon(prepared.sourceDir,true);
            await driver.setContext(firefox.Context.CHROME);
            const optionsUrl=await driver.executeScript('return WebExtensionPolicy.getByID(arguments[0]).getURL("options/options.html");',addon);
            await driver.setContext(firefox.Context.CONTENT);await driver.get(optionsUrl);
            const optionsHandle=await driver.getWindowHandle();await driver.switchTo().newWindow('tab');const readerHandle=await driver.getWindowHandle();
            evaluate=(fn,arg)=>driver.executeScript(`return (${fn})(arguments[0]);`,arg??null);
            control=async(fn,arg)=>{await driver.switchTo().window(optionsHandle);try{return await driver.executeScript(`return (${fn})(arguments[0]);`,arg??null);}finally{await driver.switchTo().window(readerHandle);}};
            navigate=url=>driver.get(url);click=selector=>driver.findElement(By.css(selector)).click();key=async value=>{const el=await driver.findElement(By.css(ACTION));await driver.executeScript('arguments[0].focus()',el);await el.sendKeys(value==='Enter'?Key.ENTER:Key.SPACE);};
            hover=async selector=>driver.actions({async:true}).move({origin:await driver.findElement(By.css(selector))}).perform();
            press=value=>driver.actions({async:true}).sendKeys(({Tab:Key.TAB,Escape:Key.ESCAPE,Enter:Key.ENTER,Space:Key.SPACE})[value]).perform();
            type=async(selector,text)=>{const el=await driver.findElement(By.css(selector));await el.click();await el.sendKeys(Key.END,text);};back=()=>driver.navigate().back();
            viewport=size=>setFirefoxContentViewport(driver,size);screenshot=async file=>{const {writeFile}=await import('node:fs/promises');await writeFile(file,await driver.takeScreenshot(),'base64');};version=(await driver.getCapabilities()).getBrowserVersion();
            optionsShot=async(width,file)=>{await driver.switchTo().window(optionsHandle);try{
                // Firefox BiDi cannot override privileged extension viewports.
                // Resize the hidden window and report its actual content size.
                await driver.manage().window().setRect({width,height:985});
                await driver.get(optionsUrl+'#capture-report');await driver.navigate().refresh();
                await waitForCondition(()=>driver.executeScript(`return (${readSettingsFragmentLanding})();`),{description:'Report editor settings landing',isReady:value=>settingsFragmentLanded(value,'#capture-report')});
                const actual=await driver.executeScript('return {width:innerWidth,height:innerHeight}');
                await driver.executeScript('document.getElementById("load-instagram-automatically").closest(".row").scrollIntoView({block:"center"})');
                if(file)await screenshot(file.replace(`-${width}.png`,`-${actual.width}.png`));return actual;
            }finally{await driver.switchTo().window(readerHandle);}};
            player=async()=>{try{await driver.switchTo().frame(await driver.findElement(By.css('.bpb-instagram-frame')));await driver.switchTo().frame(await driver.findElement(By.id('post')));
                return await evaluate(readPlayer);
            }finally{await driver.switchTo().defaultContent();}};
            nextSlide=async()=>{try{await driver.switchTo().frame(await driver.findElement(By.css('.bpb-instagram-frame')));await driver.switchTo().frame(await driver.findElement(By.id('post')));await driver.findElement(By.css('[aria-label="Next"]')).click();}finally{await driver.switchTo().defaultContent();}};
            play=async()=>{try{await driver.switchTo().frame(await driver.findElement(By.css('.bpb-instagram-frame')));await driver.switchTo().frame(await driver.findElement(By.id('post')));
                await evaluate(()=>{document.querySelector('video').muted=true;});await driver.findElement(By.css('[aria-label="Control"]')).click();
            }finally{await driver.switchTo().defaultContent();}};
        }
        const patch=update=>control(async next=>{const response=await (globalThis.browser||globalThis.chrome).runtime.sendMessage({type:'SETTINGS_PATCH',patch:next});if(!response?.ok)throw new Error('settings patch');return response.settings;},update);
        const state=()=>evaluate(()=>({count:document.querySelectorAll('.bpb-instagram').length,state:document.querySelector('.bpb-instagram')?.dataset.state,
            frames:document.querySelectorAll('.bpb-instagram-frame').length,focus:document.activeElement?.classList.contains('bpb-instagram-action'),
            theme:document.documentElement.dataset.bpbTheme,overflow:document.documentElement.scrollWidth>window.innerWidth}));
        const waitState=wanted=>waitForCondition(state,{description:`Instagram ${wanted}`,isReady:s=>s.state===wanted,timeoutMs:15_000});
        const geometry=()=>evaluate(Function(`return (()=>{const rect=${rect};return {button:rect(document.querySelector('${ACTION}')),card:rect(document.querySelector('${CARD}')),others:[...document.querySelectorAll('${CARD},#Gmap,#bpb-ascent-summary-column,#bpb-ascent-report-column')].map(rect),heading:rect(document.querySelector('main>h1')),following:rect(document.getElementById('following')),scroll:window.scrollY}})()`));
        await patch({loadInstagramAutomatically:false,enableReportEditor:true,addReportCredit:false,reportEditorMode:'rich',showWeather:false,showSunMoon:false,showSummitCloud:false,showSnotel:false});
        if(live) {
            for(const [index,url]of livePosts.entries()){
                const count=connects;await navigate(`${origin}/climber/ascent.aspx?aid=7654321&sample=${index}`);await waitState('idle');assert.equal(connects,count,'provider contacted before activation');
                await click(ACTION);await waitState('loaded');
                const content=await waitForCondition(player,{description:'live public Instagram media and caption',timeoutMs:30_000,
                    isReady:s=>s?.captionLength>0&&(index===1?s.videos.length>0:s.images>0)});
                assert(content.text.length>0);console.log(JSON.stringify({kind,version,hidden:true,viewport:'1000x900',live:true,post:url,content}));
                if(index===1){await play();const playback=await waitForCondition(player,{description:'public Reel playback',timeoutMs:25_000,isReady:s=>s?.videos.some(v=>v.width>0&&v.ready>=2&&v.time>0)});
                    console.log(JSON.stringify({kind,playback:playback.videos}));}
                if(url===CAROUSEL){
                    const initial=await waitForCondition(player,{description:'mixed carousel controls',timeoutMs:20_000,isReady:s=>s?.carousel.slides===10&&s.carousel.index===0});
                    for(let step=1;step<initial.carousel.slides;step++){
                        await nextSlide();await waitForCondition(player,{description:`carousel slide ${step+1}`,isReady:s=>s?.carousel.index===step});
                    }
                    await waitForCondition(player,{description:'carousel video player',timeoutMs:20_000,isReady:s=>s?.videos.length>0});
                    await play();const playback=await waitForCondition(player,{description:'mixed carousel video playback',timeoutMs:25_000,
                        isReady:s=>s?.videos.some(v=>v.width>0&&v.ready>=2&&v.time>0.25&&v.frames>=2)});
                    console.log(JSON.stringify({kind,carouselSlides:initial.carousel.slides,playback:playback.videos}));
                }
                if(index!==1)assert(content.captionBottom<=content.viewportHeight+1,'the caption should fit the completed post viewport');
                if(screenshots)await screenshot(path.join(screenshots,`instagram-${kind}-live-${index===0?'post':index===1?'reel':url===CAROUSEL?'carousel':'extra'}.png`));
            }
        } else {
            let cases=0;
            for(const width of [1000,375])for(const theme of ['light','dark'])for(const enlarged of [false,true]) {
                held=true;const startRequests=requests,startConnects=connects;
                await viewport({width,height:900});await patch({theme,loadInstagramAutomatically:false});
                await navigate(`${origin}/climber/ascent.aspx?aid=7654321&case=${cases}`);await waitState('idle');
                assert.equal((await state()).count,2,'native hostname links should produce two standalone post cards without embedding the external-report field');
                if(enlarged)await evaluate(()=>{const s=document.createElement('style');s.textContent='.bpb-instagram-title,.bpb-instagram-action,.bpb-instagram-link,.bpb-instagram-status{font-size:26px!important}';document.head.append(s);});
                await evaluate(()=>{document.querySelector('.bpb-instagram-action').scrollIntoView({block:'center'});});
                assert.equal(requests,startRequests);assert.equal(connects,startConnects);
                await evaluate(()=>document.querySelector('.bpb-instagram-action').click());assert.equal((await state()).state,'idle','synthetic activation accepted');
                const before=await geometry();
                if(!enlarged)assert(before.card.height<=80,`blocked post should be a compact inline row, got ${before.card.height}px`);
                const shot=state=>screenshots&&screenshot(path.join(screenshots,`instagram-${kind}-${width}-${theme}-${enlarged?'large':'normal'}-${state}.png`));
                await shot('idle');
                const available=await evaluate(()=>document.querySelector('.bpb-instagram').clientWidth>=320);
                if(!available){await click(ACTION);assert.match(await evaluate(()=>document.querySelector('.bpb-instagram-status').textContent),/widen/);stable(before,await geometry());assert.equal(requests,startRequests);cases++;continue;}
                await key('Enter');await waitState('pending');await waitForCondition(()=>requests>startRequests,{description:'one provider request'});
                stable(before,await geometry());assert((await state()).focus,'focus lost during pending');assert.equal(requests,startRequests+1);
                assert.equal(await evaluate(()=>{const f=document.querySelector('.bpb-instagram-frame');f.focus();return document.activeElement===f;}),false,'an unpainted pending player must not take focus');
                await shot('pending');
                // A same-origin packaged renderer with an invalid grant reports an
                // authenticated error; this does not trust a page-origin message.
                await evaluate(()=>{const f=document.querySelector('.bpb-instagram-frame');f.src=f.src.split('#')[0]+'?invalid=1#'+'0'.repeat(48);});
                await waitState('error');stable(before,await geometry());assert((await state()).focus);
                await shot('error');
                await key('Space');await waitState('pending');await waitForCondition(()=>requests>=startRequests+2,{description:'fresh retry'});
                stable(before,await geometry());
                held=false;for(const response of waiting)provider(response);waiting.clear();await waitState('loaded');
                stable(before,await geometry(),{expanded:true});assert.equal((await state()).frames,1,'one click enabled a second post');assert((await state()).focus);
                const remote=await player();assert.equal(remote.parentBlocked,'yes');assert.equal(remote.extensionApi,'no');
                assert(remote.captionLength>0,'the provider must include its native caption');
                assert.equal(await evaluate(()=>document.querySelector('.bpb-instagram-media').getBoundingClientRect().height),620,'one provider measurement should size the completed post');
                if(screenshots)await screenshot(path.join(screenshots,`instagram-${kind}-${width}-${theme}-${enlarged?'large':'normal'}.png`));
                await key('Enter');await waitState('idle');stable(before,await geometry());
                held=true;await key('Enter');await waitState('pending');await key('Enter');await waitState('idle');stable(before,await geometry());
                held=false;for(const response of waiting)provider(response);waiting.clear();
                await patch({loadInstagramAutomatically:true});await waitState('loaded');
                await patch({loadInstagramAutomatically:false});await waitState('idle');assert.equal((await state()).frames,0);
                cases++;
            }
            assert.equal(cases,8);
            // Reproduce the actual lazy-loader failure with a same-origin fetch
            // that intentionally has no CORS permission for an opaque origin.
            held=false;await viewport({width:1000,height:900});
            await patch({theme:'light',loadInstagramAutomatically:false});
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321`);await waitState('idle');
            await click(ACTION);await waitState('loaded');
            await evaluate(()=>document.querySelector('.bpb-instagram').scrollIntoView({block:'start'}));
            const beforeVideo=await geometry(),beforeLoads=videoLoads;
            await nextSlide();
            const videoState=await waitForCondition(player,{description:'same-origin carousel video decoding',timeoutMs:20_000,
                isReady:s=>s?.videos.some(v=>v.width>0&&v.ready>=2&&v.time>0.25&&v.frames>=2)});
            assert.equal(videoLoads,beforeLoads+1);assert.equal(formSubmissions,0,'provider forms escaped the sandbox');
            for(const key of ['parentBlocked','topBlocked','popupBlocked','navigationBlocked'])assert.equal(videoState[key],'yes',key);
            assert.equal(videoState.extensionApi,'no');stable(beforeVideo,await geometry());
            console.log(JSON.stringify({kind,fixtureCarouselPlayback:videoState.videos,providerIsolation:true}));
            const beforeHelp=requests;
            await verifyReportImageHelp({kind,version,evaluate,navigate,viewport,patch,click,hover,press,screenshot,screenshots,origin});
            assert.equal(requests,beforeHelp,'image help contacted Instagram');
            for(const width of [1280,375]){
                await viewport({width,height:900});await patch({loadInstagramAutomatically:false,theme:'light',reportEditorMode:'rich'});
                await navigate(`${origin}/climber/ascentedit.aspx?aid=7654321`);
                await waitForCondition(()=>evaluate(()=>!!document.querySelector('.bpb-re-surface[contenteditable]')),{description:'Rich editor'});
                const count=requests;
                const pasted=await evaluate(url=>{
                    const surface=document.querySelector('.bpb-re-surface[contenteditable]');surface.focus();
                    const snippet=`<blockquote class="instagram-media" data-instgrm-permalink="${url}"><a href="${url}">Post</a></blockquote><script src="https://evil.test/code.js"></script>`;
                    const data=new DataTransfer();data.setData('text/plain',snippet);
                    // Firefox's synthetic ClipboardEvent uses data/dataType;
                    // Chromium uses clipboardData. Neither touches the OS clipboard.
                    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data,data:snippet,dataType:'text/plain'});
                    surface.dispatchEvent(event);return {prevented:event.defaultPrevented,clipboard:event.clipboardData?.getData('text/plain'),html:surface.innerHTML};
                },POST);
                assert(pasted.prevented,`Rich paste was not handled: ${JSON.stringify(pasted)}`);
                await waitState('idle');assert.equal(requests,count,'paste contacted Instagram');
                await evaluate(()=>document.getElementById('bpb-report-editor').scrollIntoView({block:'start'}));
                if(screenshots)await screenshot(path.join(screenshots,`instagram-${kind}-editor-${width}.png`));
                await click('.bpb-instagram-as-link');
                assert.equal((await state()).count,0);
                await evaluate(()=>[...document.querySelectorAll('.bpb-re-mode')].find(b=>b.textContent==='Plain').click());
                const plain=await evaluate(()=>document.getElementById('JournalText').value);
                assert.match(plain,/Instagram post/);assert.doesNotMatch(plain,/script|iframe|evil\.test|instagram-media/);
                await evaluate(url=>{const input=document.getElementById('JournalText');input.value=url;input.dispatchEvent(new window.Event('input',{bubbles:true}));
                    [...document.querySelectorAll('.bpb-re-mode')].find(b=>b.textContent==='Markdown').click();},POST);
                await waitState('idle');
                await evaluate(()=>document.querySelector('.bpb-instagram-action').scrollIntoView({block:'center'}));
                const previewAvailable=await evaluate(()=>document.querySelector('.bpb-instagram').clientWidth>=320);
                if(!previewAvailable){await click(ACTION);assert.match(await evaluate(()=>document.querySelector('.bpb-instagram-status').textContent),/widen/);assert.equal(requests,count);continue;}
                await click(ACTION);await waitState('loaded');
                const previewCount=requests;
                await evaluate(()=>document.querySelector('.bpb-instagram-frame').dataset.verification='retained');
                await type('.cm-content','\n\nAfter the post.');
                await waitForCondition(()=>evaluate(()=>document.querySelector('.bpb-re-preview')?.textContent.includes('After the post.')),{description:'Markdown preview update'});
                assert(await evaluate(()=>!!document.querySelector('.bpb-instagram-frame[data-verification="retained"]')),'unrelated typing replaced the player');
                assert.equal(requests,previewCount,'unrelated typing reloaded Instagram');
                await evaluate(()=>[...document.querySelectorAll('.bpb-re-mode')].find(b=>b.textContent==='Plain').click());
                await waitForCondition(()=>evaluate(()=>!document.querySelector('.bpb-instagram-frame')),{description:'hidden preview unload'});
            }
            await navigate(`${origin}/climber/ascent.aspx?aid=7654321`);await waitState('idle');await click(ACTION);await waitState('loaded');
            const beforeBack=requests;await navigate(`${origin}/other`);await back();await waitState('idle');assert.equal(requests,beforeBack,'manual player reloaded on navigation restore');
            for(const width of [1000,375]){
                await patch({loadInstagramAutomatically:false,theme:width===1000?'dark':'light'});
                await waitForCondition(()=>control(()=>document.getElementById('load-instagram-automatically').checked===false),{description:'off Instagram option'});
                const actual=await optionsShot(width,screenshots&&path.join(screenshots,`instagram-${kind}-options-${width}.png`));
                console.log(JSON.stringify({kind,optionsViewport:actual}));
                await control(()=>document.getElementById('load-instagram-automatically').click());
                await waitForCondition(()=>control(async()=>{const api=globalThis.browser||globalThis.chrome;const local=await api.storage.local.get('bpbDeviceSettings');const sync=await api.storage.sync.get('bpbSettings');return {local:local.bpbDeviceSettings,sync:sync.bpbSettings};}),
                    {description:'device-local Instagram consent',isReady:s=>s.local?.settings?.loadInstagramAutomatically===true&&!Object.hasOwn(s.sync||{},'loadInstagramAutomatically')});
                await patch({loadInstagramAutomatically:false});
            }
            console.log(JSON.stringify({kind,version,hidden:true,cases,viewports:['1000x900','375x900'],themes:['light','dark'],text:['normal','26px'],requests,connects}));
        }
        await resources.dispose();
    } catch(error){await resources.dispose(error);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const [kind,...args]=process.argv.slice(2);
    if(args.some(arg=>arg!=='--live'&&!arg.startsWith('--screenshots='))){console.error('Unknown Instagram verification argument');process.exitCode=1;}
    else verifyInstagram(kind,{live:args.includes('--live'),screenshots:args.find(a=>a.startsWith('--screenshots='))?.slice(14)}).catch(error=>{console.error(error);process.exitCode=1;});
}
