import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, registerCleanup } from '../helpers/options-helpers.mjs';
import { waitFor } from '../helpers/load-page.mjs';
registerCleanup();
const byId = (dom, id) => dom.window.document.getElementById(id);

test('ImgBB can disconnect after a status failure with the editor off, and retry without losing focus', async () => {
    let finish, calls = 0;
    const dom = await loadOptions({ enableReportEditor: false }, { prepareChrome: chrome => {
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'PHOTO_IMGBB_REMOVE_KEY') { calls++; return new Promise(resolve => { finish = resolve; }); }
            return null;
        };
    } });
    const action = byId(dom, 'imgbb-key-remove');
    await waitFor(dom, () => !action.hidden);
    assert.equal(byId(dom, 'capture-photos').hidden, false);
    assert.equal(action.textContent, 'Disconnect');
    action.focus(); action.click(); action.click();
    await waitFor(dom, () => calls === 1);
    finish({ ok: false });
    await waitFor(dom, () => /Try Disconnect/.test(byId(dom, 'imgbb-key-status').textContent));
    assert.equal(dom.window.document.activeElement, action);
    action.click(); await waitFor(dom, () => calls === 2); finish({ ok: true });
    await waitFor(dom, () => action.hidden);
    assert.equal(dom.window.document.activeElement, byId(dom, 'imgbb-key-save'));
});

test('an older ImgBB status reply cannot restore connected UI after disconnect', async () => {
    let hold = false, release;
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'PHOTO_IMGBB_STATUS') {
                if (hold) return new Promise(resolve => { release = resolve; });
                return { ok: true, configured: true, permissionGranted: true };
            }
            return { ok: true };
        };
    } });
    const action = byId(dom, 'imgbb-key-remove');
    await waitFor(dom, () => !action.hidden);
    hold = true; dom.window.dispatchEvent(new dom.window.Event('focus'));
    await waitFor(dom, () => !!release);
    action.click(); await waitFor(dom, () => action.hidden);
    release({ ok: true, configured: true, permissionGranted: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(action.hidden, true);
    assert.match(byId(dom, 'imgbb-key-status').textContent, /No key saved/);
});

test('GitHub disconnect works without host access or repository discovery and retries in place', async () => {
    let finish, calls = 0, requests = 0, hasToken = true, reads = 0;
    const dom = await loadOptions({}, { prepareChrome: chrome => {
        chrome.permissions = { contains: async () => false, request: async () => { requests++; return false; } };
        chrome.runtime.sendMessage = async message => {
            if (message.type === 'GITHUB_AUTH_STATUS') { reads++; return { hasToken, connected: false }; }
            if (message.type === 'GITHUB_AUTH_DISCONNECT') { calls++; return new Promise(resolve => { finish = value => {
                if (value?.connected === false) hasToken = false;
                resolve(value);
            }; }); }
            return { ok: true };
        };
    } });
    const action = byId(dom, 'github-disconnect');
    await waitFor(dom, () => !action.hidden);
    action.focus(); action.click(); action.click(); await waitFor(dom, () => calls === 1);
    const panel = byId(dom, 'github-panel').firstChild;
    finish(null);
    await waitFor(dom, () => /could not be removed/.test(byId(dom, 'github-disconnect-status').textContent));
    assert.equal(byId(dom, 'github-panel').firstChild, panel);
    assert.equal(dom.window.document.activeElement, action);
    action.click(); await waitFor(dom, () => calls === 2); finish({ connected: false, hasToken: false });
    await waitFor(dom, () => action.hidden);
    assert.equal(requests, 0);
    assert.equal(dom.window.document.activeElement.textContent, 'Connect GitHub');
    const focused = dom.window.document.activeElement, previousReads = reads;
    await dom.chrome.storage.local.set({ bpbGithubAuth: null });
    await waitFor(dom, () => reads > previousReads);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(dom.window.document.activeElement, focused, 'The credential storage notification must preserve completion focus');
});
