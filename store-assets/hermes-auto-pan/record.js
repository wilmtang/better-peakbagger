import { chromium } from 'playwright';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function run() {
  console.log('Launching browser to record promotional assets (with tilting)...');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width: 1200, height: 1350 },
    recordVideo: {
      dir: path.resolve(root, 'store-assets', 'hermes-auto-pan'),
      size: { width: 1200, height: 1350 }
    },
    args: [
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await context.newPage();
  console.log('Navigating to Peakbagger ascent page...');
  await page.goto('https://www.peakbagger.com/climber/ascent.aspx?aid=2775541', { waitUntil: 'load' });
  await page.waitForTimeout(5000);

  // Clean up page styles and hide unrelated elements to make it incredibly clean & beautiful
  console.log('Cleaning up page DOM for recording...');
  await page.evaluate(() => {
    // Set pure white background
    document.body.style.backgroundImage = 'none';
    document.body.style.backgroundColor = '#ffffff';
    document.documentElement.style.backgroundColor = '#ffffff';

    // Hide any clutter like footer, ads, external links below the chart
    const selectorsToHide = [
      'footer',
      '#footer',
      '.viewcounter',
      'hr',
    ];
    selectorsToHide.forEach(sel => {
      const el = document.querySelector(sel);
      if (el && el.style) el.style.setProperty('display', 'none', 'important');
    });
  });

  // Scroll to the very bottom so the stats tables are scrolled off-screen
  // and the map + chart fill the entire screen beautifully!
  console.log('Scrolling to the very bottom...');
  await page.evaluate(() => {
    window.scrollTo(0, 10000);
  });
  await page.waitForTimeout(2000);

  // 1. Transition to 3D Map
  console.log('Clicking 3D button...');
  const toggleBtn = page.locator('#bpb-terrain-toggle');
  await toggleBtn.click();
  await page.waitForTimeout(1000);

  // If consent modal appears, click enable
  const consentBtn = page.locator('.bpb-terrain-consent-primary');
  if (await consentBtn.isVisible()) {
    console.log('Consent modal detected, clicking "Enable and open 3D"...');
    await consentBtn.click();
    await page.waitForTimeout(1000);
  }

  console.log('Waiting for 3D map to load terrain...');
  await page.waitForTimeout(6000); // Give plenty of time to load the gorgeous 3D terrain

  // 2. Resize map viewport size
  console.log('Resizing map viewport size...');
  const resizeHandle = page.locator('#bpb-map-resize-handle');
  await resizeHandle.focus();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);

  // Re-scroll to bottom because resizing changes the scroll height!
  console.log('Re-scrolling to bottom after resize...');
  await page.evaluate(() => {
    window.scrollTo(0, 10000);
  });
  await page.waitForTimeout(1000);

  // 3. Zoom, Pan, and Tilt
  console.log('Zooming, panning, and tilting 3D map...');
  const terrainFrame = page.locator('#bpb-terrain-frame');
  const frameBox = await terrainFrame.boundingBox();
  if (frameBox) {
    const cx = frameBox.x + frameBox.width / 2;
    const cy = frameBox.y + frameBox.height / 2;
    
    // Zoom in
    console.log('Zooming in...');
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -150);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1500);

    // Pan
    console.log('Panning...');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 60, { steps: 30 });
    await page.mouse.up();
    await page.waitForTimeout(1500);

    // Tilt (right-drag up)
    console.log('Tilting (right-drag up)...');
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx, cy - 120, { steps: 30 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(2000);
  }

  // 4. Strava style map synchronization (mouse on chart shows a dot on map)
  console.log('Performing chart-map synchronization...');
  const chartCanvas = page.locator('#bpb-gpx-analysis canvas');
  const chartBox = await chartCanvas.boundingBox();
  if (chartBox) {
    const startX = chartBox.x + 80;
    const endX = chartBox.x + chartBox.width - 80;
    const y = chartBox.y + chartBox.height / 2;

    await page.mouse.move(startX, y);
    await page.waitForTimeout(500);

    // Sweep mouse slowly to the right
    const steps = 45;
    for (let i = 0; i <= steps; i++) {
      const x = startX + (endX - startX) * (i / steps);
      await page.mouse.move(x, y);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(1500);
  }

  // 5. Click on a nearby mountain peakbagger marker and dismiss
  console.log('Clicking on nearby peak marker...');
  if (frameBox) {
    const cx = frameBox.x + frameBox.width / 2;
    const cy = frameBox.y + frameBox.height / 2;

    // Click near Grand Teton to select a nearby peak (e.g., Middle Teton or South Teton is nearby)
    await page.mouse.click(cx + 100, cy - 80);
    await page.waitForTimeout(3500); // Show popup name bubble

    // Try to click dismiss/close on any popup close button if visible
    const closeBtn = page.frameLocator('#bpb-terrain-frame').locator('.maplibregl-popup-close-button');
    if (await closeBtn.isVisible()) {
      console.log('Dismissing peak popup...');
      await closeBtn.click();
      await page.waitForTimeout(1500);
    } else {
      // Otherwise just click somewhere blank to dismiss
      console.log('Clicking blank space to dismiss...');
      await page.mouse.click(cx - 150, cy - 150);
      await page.waitForTimeout(1500);
    }
  }

  console.log('Saving video and cleaning up...');
  await context.close();
}

run().catch(console.error);
