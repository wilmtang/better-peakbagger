// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options-page GitHub backup setup.
//
// This is the setup surface only. It never sees the token: the background
// worker owns the device-flow poll and the storage.local token/repo, and this
// page drives it through GITHUB_AUTH_* messages, showing the user code, handing
// off to GitHub's own install page for repository scoping, then discovering and
// selecting the granted repo. Enabling the feature first requests the optional
// github.com / api.github.com host permissions that the worker needs.

const GITHUB_ORIGINS = ['https://github.com/*', 'https://api.github.com/*'];

// One actionable sentence per typed failure from the background worker.
const ERROR_TEXT = {
    network: 'Could not reach GitHub. Check your connection and try again.',
    denied: 'The authorization was declined on GitHub.',
    expired: 'The authorization expired before it was approved. Try again.',
    cancelled: 'Connection cancelled.',
    'device-flow-disabled': 'Device flow is not enabled for the app. Please report this.',
    'no-token': 'The GitHub connection was lost. Connect again.',
    'no-access': 'This repository is not writable. Check its GitHub App access and try again.',
    archived: 'This repository is archived and read-only. Choose another repository.',
    'branch-missing': 'This repository has no usable default branch. Choose another repository.',
    'repo-conflict': 'This repository already contains paths that Better Peakbagger cannot safely adopt. Choose another repository.',
    'rate-limit': 'GitHub is rate-limiting requests. Try again in a few minutes.',
    unknown: 'Something went wrong talking to GitHub. Try again.',
};
const errorText = code => ERROR_TEXT[code] || ERROR_TEXT.unknown;

export function initGithubBackup({ extensionApi, flash, save }) {
    const enableEl = document.getElementById('enable-github-backup');
    const detailEl = document.getElementById('github-detail');
    const panelEl = document.getElementById('github-panel');
    if (!enableEl || !detailEl || !panelEl) return { populate() {} };

    let pollTimer = null;
    let countdownTimer = null;
    let permissionError = false;
    let choosingRepo = false;
    const stopPollTimer = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
    const stopTimers = () => {
        stopPollTimer();
        if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
    };

    const send = message => new Promise(resolve => {
        try {
            extensionApi.runtime.sendMessage(message, response => {
                void extensionApi.runtime.lastError; // reading clears the warning
                resolve(response || null);
            });
        } catch { resolve(null); }
    });

    // ---- small DOM builders ------------------------------------------------

    const el = (tag, props = {}, children = []) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'checked') node.checked = !!value;
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else if (value != null) node.setAttribute(key, value);
        }
        for (const child of [].concat(children)) if (child) node.appendChild(child);
        return node;
    };
    const button = (label, { primary = false, onClick } = {}) =>
        el('button', { type: 'button', class: primary ? 'github-primary' : 'secondary', text: label, onclick: onClick });
    const openTab = url => { try { window.open(url, '_blank', 'noopener'); } catch { /* popup blocked */ } };
    const render = (...nodes) => { panelEl.replaceChildren(...nodes.filter(Boolean)); };
    const newRepositoryUrl = status => {
        const url = new URL('https://github.com/new');
        url.searchParams.set('name', 'better-peakbagger-backup');
        url.searchParams.set('description', 'Peakbagger ascent backups created by Better Peakbagger');
        url.searchParams.set('visibility', 'private');
        if (status && status.account && status.account.login) url.searchParams.set('owner', status.account.login);
        return url.href;
    };

    // ---- phase renderers ---------------------------------------------------

    const renderDisconnected = () => render(
        el('p', { class: 'github-line', text: 'Connect a GitHub account, then pick one repository to hold your ascent backups.' }),
        el('div', { class: 'github-actions' }, button('Connect GitHub', { primary: true, onClick: connect })),
    );

    const renderPermissionDenied = () => {
        stopTimers();
        detailEl.hidden = false;
        render(
            el('p', { class: 'github-line github-error', text: 'GitHub access wasn’t granted. Allow access to GitHub to enable backups.' }),
            el('div', { class: 'github-actions' }, button('Try again', { primary: true, onClick: requestGithubPermission })),
        );
    };

    const renderConnecting = code => {
        const codeValue = el('span', { class: 'github-code-value', text: code.userCode || '········' });
        const copyLabel = el('span', { class: 'github-code-copy', text: 'Copy' });
        const codeBox = el('button', {
            type: 'button', class: 'github-code', 'aria-label': `Copy device code ${code.userCode || ''}`.trim(),
            onclick: async () => {
                try {
                    await navigator.clipboard.writeText(code.userCode || '');
                    copyLabel.textContent = 'Copied';
                } catch {
                    const selection = window.getSelection();
                    if (selection) { selection.removeAllRanges(); const range = document.createRange(); range.selectNodeContents(codeValue); selection.addRange(range); }
                    copyLabel.textContent = 'Select and copy';
                }
            },
        }, [codeValue, copyLabel]);
        const hint = el('p', { class: 'github-hint' });
        render(
            el('p', { class: 'github-line', text: 'Enter this code on GitHub to authorize Better Peakbagger:' }),
            codeBox,
            el('div', { class: 'github-actions' }, [
                button('Open github.com/login/device', { primary: true, onClick: () => openTab(code.verificationUriComplete || code.verificationUri || 'https://github.com/login/device') }),
                button('Cancel', { onClick: cancelConnect }),
            ]),
            hint,
        );
        const deadline = (Number(code.startedAt) || Date.now()) + (Number(code.expiresIn) || 900) * 1000;
        const updateCountdown = () => {
            const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            if (remaining <= 0) { renderError('expired'); return; }
            const minutes = Math.floor(remaining / 60);
            const seconds = String(remaining % 60).padStart(2, '0');
            hint.textContent = `Waiting for approval · Expires in ${minutes}:${seconds}`;
            countdownTimer = setTimeout(updateCountdown, 1000);
        };
        updateCountdown();
    };

    const renderChooseRepo = (status, discovery) => {
        choosingRepo = true;
        const repos = (discovery && discovery.repos) || [];
        const installUrl = status.installUrl;
        const createButton = button('Create repository on GitHub', {
            primary: repos.length === 0,
            onClick: () => openTab(newRepositoryUrl(status)),
        });
        if (repos.length) {
            const list = el('div', { class: 'github-repo-list', role: 'list' },
                repos.map(repo => el('button', {
                    type: 'button', class: 'github-repo', role: 'listitem', text: repo.fullName,
                    onclick: () => selectRepo(repo),
                })));
            return render(
                el('p', { class: 'github-line', text: 'Choose a repository for your backups. A dedicated repository keeps everything tidy.' }),
                list,
                el('div', { class: 'github-actions' }, [
                    createButton,
                    button('Change GitHub access', { onClick: () => openTab(installUrl) }),
                ]),
                el('p', { class: 'github-hint', text: 'Created a new repository? Grant Better Peakbagger access to it on GitHub, then return here.' }),
            );
        }
        // None granted yet (or the install page not visited): offer the clean
        // dedicated-repository path first, then GitHub's access picker.
        return render(
            el('p', { class: 'github-line', text: 'Create a private backup repository, or grant access to one you already have.' }),
            el('div', { class: 'github-actions' }, [
                createButton,
                button('Grant repository access', { onClick: () => openTab(installUrl) }),
                button('Refresh list', { onClick: () => refreshRepos({ choose: true }) }),
            ]),
            el('p', { class: 'github-hint', text: 'After creating a repository, grant Better Peakbagger access to it. Return here and the list will refresh.' }),
        );
    };

    const renderExistingRepoConfirmation = repo => {
        choosingRepo = true;
        const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
        render(
            el('p', { class: 'github-line', text: `${fullName} already contains files.` }),
            el('p', { class: 'github-hint', text: 'Existing files will stay in place. Better Peakbagger will add clearly named mountain folders at the repository root.' }),
            el('div', { class: 'github-actions' }, [
                button('Use this repository', { primary: true, onClick: () => selectRepo(repo, { confirmExisting: true }) }),
                button('Choose another', { onClick: () => refreshRepos({ choose: true }) }),
            ]),
        );
    };

    const renderConnected = status => {
        choosingRepo = false;
        const who = status.account && status.account.login ? `@${status.account.login}` : 'GitHub';
        const repo = status.repo ? status.repo.fullName || `${status.repo.owner}/${status.repo.name}` : '';
        const autoToggle = el('label', { class: 'github-auto', for: 'github-auto-backup' }, [
            el('input', {
                type: 'checkbox', id: 'github-auto-backup', checked: !!status.auto,
                onchange: event => { void save({ autoGithubBackup: event.target.checked }); },
            }),
            el('span', { text: 'Back up automatically after each save' }),
        ]);
        render(
            el('p', { class: 'github-line github-connected' }, [
                el('span', { class: 'github-dot' }),
                el('span', { text: `Connected as ${who} · backing up to ${repo}` }),
            ]),
            autoToggle,
            el('div', { class: 'github-actions' }, [
                button('Change repository', { onClick: () => refreshRepos({ choose: true }) }),
                button('Disconnect', { onClick: disconnect }),
            ]),
        );
    };

    const renderError = (code, retry, actionLabel = 'Try again') => {
        stopTimers();
        render(
            el('p', { class: 'github-line github-error', text: errorText(code) }),
            el('div', { class: 'github-actions' }, button(actionLabel, { primary: true, onClick: retry || connect })),
        );
    };

    // ---- flow --------------------------------------------------------------

    const connect = async () => {
        stopTimers();
        render(el('p', { class: 'github-line', text: 'Contacting GitHub…' }));
        const res = await send({ type: 'GITHUB_AUTH_BEGIN' });
        if (!res || res.phase === 'error') return renderError(res && res.code);
        renderConnecting(res);
        pollAuth();
    };

    const cancelConnect = async () => {
        stopTimers();
        await send({ type: 'GITHUB_AUTH_DISCONNECT' });
        renderDisconnected();
    };

    const pollAuth = () => {
        stopPollTimer();
        pollTimer = setTimeout(async () => {
            const state = await send({ type: 'GITHUB_AUTH_STATE' });
            if (!state) return pollAuth();
            if (state.phase === 'polling') return pollAuth();
            if (state.phase === 'idle') return renderError('no-token');
            if (state.phase === 'error') return renderError(state.code);
            if (state.phase === 'authorized') return afterAuthorized();
            return pollAuth();
        }, 2000);
    };

    const afterAuthorized = async () => {
        stopTimers();
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (status && status.connected) { flash('GitHub connected'); return renderConnected(status); }
        const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
        if (discovery && discovery.phase === 'error') return renderError(discovery.code, afterAuthorized);
        const refreshed = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (refreshed && refreshed.connected) { flash('GitHub connected'); return renderConnected(refreshed); }
        return renderChooseRepo(refreshed || status || {}, discovery);
    };

    const refreshRepos = async ({ choose = false } = {}) => {
        render(el('p', { class: 'github-line', text: 'Checking repository access…' }));
        const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
        if (discovery && discovery.phase === 'error') return renderError(discovery.code, refreshRepos);
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!choose && status && status.connected) { flash('Repository selected'); return renderConnected(status); }
        return renderChooseRepo(status || {}, discovery);
    };

    const selectRepo = async (repo, { confirmExisting = false } = {}) => {
        render(el('p', { class: 'github-line', text: 'Checking repository safety…' }));
        const status = await send({ type: 'GITHUB_AUTH_SELECT_REPO', repo, confirmExisting });
        if (status && status.connected) { flash('Repository selected'); return renderConnected(status); }
        if (status && status.needsConfirmation) return renderExistingRepoConfirmation(repo);
        if (status && status.error) {
            return renderError(status.error.code, () => refreshRepos({ choose: true }), 'Choose another');
        }
        return refreshRepos({ choose: true });
    };

    const disconnect = async () => {
        stopTimers();
        await send({ type: 'GITHUB_AUTH_DISCONNECT' });
        flash('GitHub disconnected');
        renderDisconnected();
    };

    // Show the connection state for the current stored status.
    const renderFromStatus = async () => {
        if (permissionError) return renderPermissionDenied();
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!status || !status.enabled) { detailEl.hidden = true; stopTimers(); return; }
        detailEl.hidden = false;
        if (status.connected) return renderConnected(status);
        if (status.hasToken) {
            const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
            const after = await send({ type: 'GITHUB_AUTH_STATUS' });
            if (after && after.connected) return renderConnected(after);
            return renderChooseRepo(after || status, discovery);
        }
        return renderDisconnected();
    };

    // ---- toggle ------------------------------------------------------------

    async function requestGithubPermission() {
        permissionError = false;
        let granted = false;
        try {
            granted = await extensionApi.permissions.request({ origins: GITHUB_ORIGINS });
        } catch { granted = false; }
        if (!granted) {
            enableEl.checked = false;
            permissionError = true;
            renderPermissionDenied();
            return;
        }
        enableEl.checked = true;
        await save({ enableGithubBackup: true });
        await renderFromStatus();
    }

    enableEl.addEventListener('change', async () => {
        if (enableEl.checked) {
            await requestGithubPermission();
        } else {
            permissionError = false;
            stopTimers();
            await save({ enableGithubBackup: false, autoGithubBackup: false });
            detailEl.hidden = true;
        }
    });

    // Returning from the GitHub install page: re-check repo access.
    window.addEventListener('focus', () => {
        if (!detailEl.hidden && !pollTimer) {
            if (choosingRepo) void refreshRepos({ choose: true });
            else void renderFromStatus();
        }
    });

    // populate runs on every settings change, but the panel's connected state
    // comes from the background, not settings — so only re-render when the gate
    // itself flips (or on first paint), never on an unrelated save.
    let painted = false;
    let lastEnabled = null;
    return {
        populate(settings) {
            const enabled = !!settings.enableGithubBackup;
            enableEl.checked = enabled;
            if (!enabled && permissionError) { detailEl.hidden = false; return; }
            if (!painted || enabled !== lastEnabled) {
                painted = true;
                lastEnabled = enabled;
                if (!pollTimer) void renderFromStatus();
            }
        },
    };
}
