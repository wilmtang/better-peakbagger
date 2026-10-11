import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, el, registerCleanup } from '../helpers/options-helpers.mjs';

registerCleanup();

test('About offers feedback on GitHub Discussions and opens external links safely', async () => {
    const dom = await loadOptions({}, { hash: '#about' });
    const links = Array.from(el(dom, 'about').querySelectorAll('.about-links a'));
    const feedback = links.find(link => link.textContent === 'Feedback');
    assert.equal(feedback?.href, 'https://github.com/wilmtang/better-peakbagger/discussions');
    for (const link of links) {
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
    }
});

test('About sends Chromium clients to Chrome Web Store reviews even with a browser API alias', async () => {
    const dom = await loadOptions({}, {
        prepareWindow: window => {
            window.browser = window.chrome;
            Object.defineProperty(window.navigator, 'userAgent', { value: 'Firefox/153.0' });
        },
    });
    const rateUs = el(dom, 'about-rate-us');
    assert.equal(rateUs.textContent, 'Rate us');
    assert.equal(rateUs.href,
        'https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn/reviews');
});

test('About sends Firefox clients to Firefox Add-ons reviews', async () => {
    const dom = await loadOptions({}, {
        prepareChrome: chrome => {
            chrome.runtime.getURL = path => `moz-extension://test-extension/${path}`;
        },
        prepareWindow: window => { window.browser = window.chrome; },
    });
    assert.equal(el(dom, 'about-rate-us').href,
        'https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/reviews/');
});
