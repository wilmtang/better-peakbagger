// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — options-page GitHub connection and ascent-backup setup.
//
// This is the setup surface only. It never sees the token: the background
// worker owns the device-flow poll and the storage.local token/repo, and this
// page drives it through GITHUB_AUTH_* messages, showing the user code, handing
// off to GitHub's own install page for repository scoping, then discovering and
// selecting the granted repo. The shared Connect action requests the optional
// github.com / api.github.com host permissions that the worker needs; the
// ascent-backup setting controls only ascent-specific affordances and writes.

import { githubError as GithubError } from '../src/github/github-error-copy.js';
import { githubErrors as GithubErrors } from '../src/github/github-errors.js';
import { dom as Dom } from '../src/ui/dom.js';
import { runtimeMessage as RuntimeMessage } from '../src/ui/runtime-message.js';
import { optionsUtils as OptionsUtils } from './options-utils.js';

const { ERROR_CODES } = GithubErrors;

export const GITHUB_ORIGINS = ['https://github.com/*', 'https://api.github.com/*'];
export const hasGithubPermission = async extensionApi => {
    if (!extensionApi?.permissions?.contains) return false;
    try { return !!(await extensionApi.permissions.contains({ origins: GITHUB_ORIGINS })); }
    catch { return false; }
};
const errorText = error => GithubError.message(error, {
    fallback: 'GitHub did not return a usable response. Reload Settings and try again.',
});

export function initGithubBackup({ extensionApi, flash, save }) {
    const enableEl = document.getElementById('enable-github-backup');
    const detailEl = document.getElementById('github-detail');
    const panelEl = document.getElementById('github-panel');
    const ascentDetailEl = document.getElementById('github-ascent-detail');
    const ascentPanelEl = document.getElementById('github-ascent-panel');
    if (OptionsUtils.logMissingElements('GitHub settings', {
        'enable-github-backup': enableEl,
        'github-detail': detailEl,
        'github-panel': panelEl,
        'github-ascent-detail': ascentDetailEl,
        'github-ascent-panel': ascentPanelEl,
    })) {
        return { populate() {} };
    }

    let pollTimer = null;
    let countdownTimer = null;
    let permissionError = false;
    let choosingRepo = false;
    let currentSettings = {
        enableGithubBackup: false,
        autoGithubBackup: false,
        removeGithubBackupOnDelete: false,
    };
    let currentStatus = null;
    let currentAscentSummary = null;
    // The summary costs a real GitHub API call (client.getAscentFolders), so it
    // is cached with a short TTL rather than being invalidated whenever the
    // window regains focus. A repository change and the explicit Try again
    // control still force a refetch.
    const ASCENT_SUMMARY_TTL_MS = 60_000;
    let ascentSummaryAt = 0;
    // Armed only when we send the user to GitHub, and disarmed once consumed.
    let awaitingGithubReturn = false;
    // A confirmation the user is reading must never be replaced underneath them.
    let confirmingExistingRepo = false;
    let ascentSummaryRevision = 0;
    const stopPollTimer = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
    const stopTimers = () => {
        stopPollTimer();
        if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
    };

    const send = RuntimeMessage.bind(extensionApi);

    // ---- small DOM builders ------------------------------------------------

    const el = Dom.element;
    const button = (label, { primary = false, onClick } = {}) =>
        el('button', { type: 'button', class: primary ? 'github-primary' : 'secondary', text: label, onclick: onClick });
    // One way out to an external page. tabs.create is preferred and cannot be
    // popup-blocked; window.open is the last resort for a context without the
    // tabs API, and no longer swallows its failure — "Open
    // github.com/login/device" is the single action the whole device flow
    // depends on, so it must never do nothing without saying so.
    const openTab = url => { window.open(url, '_blank', 'noopener'); };
    const createTab = async url => {
        if (extensionApi.tabs && typeof extensionApi.tabs.create === 'function') {
            await extensionApi.tabs.create({ url });
            return;
        }
        openTab(url);
    };
    const openExternal = async (url, description, { expectReturn = false } = {}) => {
        try {
            await createTab(url);
            // Only a trip to GitHub arms the return check.
            if (expectReturn) awaitingGithubReturn = true;
        } catch {
            flash(`${description} couldn’t be opened. Check your browser settings, then try again.`,
                { error: true });
        }
    };
    const renderInto = (target, ...nodes) => { target.replaceChildren(...nodes.filter(Boolean)); };
    const render = (...nodes) => { renderInto(panelEl, ...nodes); };
    const renderAscent = (...nodes) => { renderInto(ascentPanelEl, ...nodes); };
    const newRepositoryUrl = status => {
        const url = new URL('https://github.com/new');
        url.searchParams.set('name', 'better-peakbagger-backup');
        url.searchParams.set('description', 'Backups and transfers created by Better Peakbagger');
        url.searchParams.set('visibility', 'private');
        if (status && status.account && status.account.login) url.searchParams.set('owner', status.account.login);
        return url.href;
    };

    // ---- phase renderers ---------------------------------------------------

    const renderDisconnected = () => render(
        el('p', { class: 'github-line', text: 'Connect a GitHub account, then choose one repository for Better Peakbagger backups and transfers.' }),
        el('div', { class: 'github-actions' }, button('Connect GitHub', { primary: true, onClick: ensureConnection })),
    );

    const renderPermissionDenied = () => {
        stopTimers();
        detailEl.hidden = false;
        render(
            el('p', { class: 'github-line github-error', text: 'GitHub access wasn’t granted. Allow access to GitHub to connect.' }),
            el('div', { class: 'github-actions' }, button('Try again', { primary: true, onClick: ensureConnection })),
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
                button('Open github.com/login/device', {
                    primary: true,
                    onClick: () => openExternal(
                        code.verificationUriComplete || code.verificationUri || 'https://github.com/login/device',
                        'The GitHub device page'
                    )
                }),
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
        confirmingExistingRepo = false;
        const repos = (discovery && discovery.repos) || [];
        const installUrl = status.installUrl;
        const createButton = button('Create repository on GitHub', {
            primary: repos.length === 0,
            onClick: () => openExternal(newRepositoryUrl(status), 'The new-repository page', { expectReturn: true }),
        });
        if (repos.length) {
            const list = el('div', { class: 'github-repo-list', role: 'list' },
                repos.map(repo => el('button', {
                    type: 'button', class: 'github-repo', role: 'listitem', text: repo.fullName,
                    onclick: () => selectRepo(repo),
                })));
            return render(
                el('p', { class: 'github-line', text: 'Choose a repository for Better Peakbagger. A dedicated repository keeps everything tidy.' }),
                list,
                el('div', { class: 'github-actions' }, [
                    createButton,
                    button('Change GitHub access', {
                        onClick: () => openExternal(installUrl, 'The GitHub access page', { expectReturn: true }),
                    }),
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
                button('Grant repository access', {
                    onClick: () => openExternal(installUrl, 'The GitHub access page', { expectReturn: true }),
                }),
                button('Refresh list', { onClick: () => refreshRepos({ choose: true }) }),
            ]),
            el('p', { class: 'github-hint', text: 'After creating a repository, grant Better Peakbagger access to it. Return here and the list will refresh.' }),
        );
    };

    const renderExistingRepoConfirmation = repo => {
        choosingRepo = true;
        confirmingExistingRepo = true;
        const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
        render(
            el('p', { class: 'github-line', text: `${fullName} already contains files.` }),
            el('p', { class: 'github-hint', text: 'Existing files will stay in place. Better Peakbagger will add its own files and mountain folders at the repository root.' }),
            el('div', { class: 'github-actions' }, [
                button('Use this repository', { primary: true, onClick: () => selectRepo(repo, { confirmExisting: true }) }),
                button('Choose another', { onClick: () => refreshRepos({ choose: true }) }),
            ]),
        );
    };

    const repositoryUrl = status => {
        const owner = status?.repo?.owner;
        const name = status?.repo?.name;
        if (!owner || !name) return null;
        return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    };

    // The repository belongs to the connection, not to any one backup, so its
    // link sits here beside the account rather than inside ascent backup.
    const renderConnected = status => {
        choosingRepo = false;
        confirmingExistingRepo = false;
        const who = status.account && status.account.login ? `@${status.account.login}` : 'GitHub';
        const repo = status.repo ? status.repo.fullName || `${status.repo.owner}/${status.repo.name}` : '';
        const url = repositoryUrl(status);
        render(
            el('p', { class: 'github-line github-connected' }, [
                el('span', { class: 'github-dot' }),
                el('span', { text: `Connected as ${who} · Repository ${repo}` }),
            ]),
            el('div', { class: 'github-actions' }, [
                url ? el('a', {
                    class: 'secondary', href: url,
                    target: '_blank', rel: 'noopener noreferrer', text: 'View repository',
                }) : null,
                button('Change repository', { onClick: () => refreshRepos({ choose: true }) }),
                button('Disconnect', { onClick: disconnect }),
            ].filter(Boolean)),
        );
    };

    const paintAscentSummary = (summaryEl, status, summary) => {
        summaryEl.classList.toggle('github-error', !!summary && !summary.ok);
        summaryEl.classList.toggle('github-backup-confirmed', !!summary && summary.ok && summary.count > 0);
        if (!summary) {
            summaryEl.textContent = 'Checking existing backups…';
            return;
        }
        if (!summary.ok) {
            summaryEl.replaceChildren(
                document.createTextNode(`Couldn’t check existing backups. ${errorText(summary.error)}`),
                document.createTextNode(' '),
                el('button', {
                    type: 'button', class: 'github-link', text: 'Try again',
                    onclick: () => { forgetAscentSummary(); void refreshAscentSummary(summaryEl, status); },
                }),
            );
            return;
        }
        const count = Number.isInteger(summary.count) && summary.count >= 0 ? summary.count : 0;
        const repo = status?.repo?.fullName || `${status?.repo?.owner}/${status?.repo?.name}`;
        summaryEl.textContent = count === 0
            ? 'No ascents backed up yet.'
            : `${count} ascent${count === 1 ? '' : 's'} backed up to ${repo}.`;
    };

    const ascentSummaryFresh = () =>
        !!currentAscentSummary && (Date.now() - ascentSummaryAt) < ASCENT_SUMMARY_TTL_MS;
    const forgetAscentSummary = () => { currentAscentSummary = null; ascentSummaryAt = 0; };

    const refreshAscentSummary = async (summaryEl, status) => {
        const revision = ++ascentSummaryRevision;
        paintAscentSummary(summaryEl, status, null);
        const response = await send({ type: 'GITHUB_ASCENT_BACKUP_SUMMARY' });
        if (revision !== ascentSummaryRevision || !summaryEl.isConnected) return;
        currentAscentSummary = response && typeof response === 'object'
            ? response
            : { ok: false, error: null };
        ascentSummaryAt = Date.now();
        paintAscentSummary(summaryEl, status, currentAscentSummary);
    };

    const renderAscentConnected = status => {
        const summaryEl = el('p', {
            class: 'github-line github-backup-summary', role: 'status', 'aria-live': 'polite',
        });
        const historyStatus = el('p', { class: 'github-hint github-error github-history-status', role: 'status' });
        historyStatus.hidden = true;
        const showHistoryError = (message, { offerSignIn = false } = {}) => {
            const children = [document.createTextNode(message)];
            if (offerSignIn) {
                children.push(
                    document.createTextNode(' '),
                    el('button', {
                        type: 'button', class: 'github-link', text: 'Sign in to Peakbagger',
                        onclick: async () => {
                            try {
                                await createTab('https://www.peakbagger.com/Climber/Login.aspx');
                            } catch {
                                showHistoryError('The Peakbagger sign-in tab could not be opened. Check your browser settings, then try again.');
                            }
                        },
                    }),
                );
            }
            historyStatus.replaceChildren(...children);
            historyStatus.hidden = false;
        };
        const openMyAscents = async event => {
            const control = event.currentTarget;
            control.disabled = true;
            control.textContent = 'Opening…';
            historyStatus.hidden = true;
            const response = await send({ type: 'PEAKBAGGER_MY_ASCENTS' });
            if (response && response.ok && response.url) {
                try {
                    await createTab(response.url);
                } catch {
                    showHistoryError('The My Ascents tab could not be opened. Check your browser settings, then try again.');
                }
            } else {
                const message = response && response.error && response.error.message
                    ? response.error.message
                    : 'Peakbagger could not find your My Ascents page. Confirm you’re signed in, then try again.';
                showHistoryError(message, { offerSignIn: response && response.error && response.error.code === 'peakbagger-signed-out' });
            }
            control.disabled = false;
            control.textContent = 'Open My Ascents';
        };
        const autoToggle = el('label', { class: 'github-auto', for: 'github-auto-backup' }, [
            el('input', {
                type: 'checkbox', id: 'github-auto-backup', checked: !!currentSettings.autoGithubBackup,
                onchange: event => { void save({ autoGithubBackup: event.target.checked }); },
            }),
            el('span', { text: 'Back up automatically after each save' }),
        ]);
        const deleteToggle = el('label', { class: 'github-auto', for: 'github-delete-backup' }, [
            el('input', {
                type: 'checkbox', id: 'github-delete-backup',
                checked: !!currentSettings.removeGithubBackupOnDelete,
                onchange: event => { void save({ removeGithubBackupOnDelete: event.target.checked }); },
            }),
            el('span', { text: 'Remove backup files after I delete an ascent' }),
        ]);
        const deleteHint = el('p', {
            class: 'github-hint',
            text: 'Peakbagger is checked first. Better Peakbagger removes only its report, ascent data, and GPX from the current branch; Git history and your own files remain.',
        });
        const historyHint = el('p', { class: 'github-hint github-history' }, [
            document.createTextNode('New saves and edits are backed up automatically. To back up ascents saved before you connected, '),
            el('button', { type: 'button', class: 'github-link', text: 'Open My Ascents', onclick: openMyAscents }),
            document.createTextNode(' and choose Back up all ascents (it covers every year).'),
        ]);
        renderAscent(
            summaryEl,
            autoToggle,
            deleteToggle,
            deleteHint,
            historyHint,
            historyStatus,
        );
        if (ascentSummaryFresh()) paintAscentSummary(summaryEl, status, currentAscentSummary);
        else void refreshAscentSummary(summaryEl, status);
    };

    const renderAscentStatus = (status = currentStatus) => {
        ascentSummaryRevision++;
        const enabled = !!currentSettings.enableGithubBackup;
        ascentDetailEl.hidden = !enabled;
        if (!enabled) {
            renderAscent();
            return;
        }
        if (status?.permissionGranted && status.connected) {
            renderAscentConnected(status);
            return;
        }
        renderAscent(el('p', {
            class: 'github-line',
            text: 'Connect GitHub above to back up ascents.',
        }));
    };

    const rememberStatus = status => {
        const connectedRepo = value => value?.permissionGranted && value.connected
            ? `${value.repo?.owner || ''}/${value.repo?.name || ''}`
            : '';
        if (connectedRepo(currentStatus) !== connectedRepo(status)) forgetAscentSummary();
        currentStatus = status || null;
        renderAscentStatus();
        return currentStatus;
    };

    const renderError = (error, retry, actionLabel = 'Try again') => {
        stopTimers();
        const code = typeof error === 'string' ? error : error && error.code;
        if (code === 'auth' || code === 'no-token') {
            retry = reconnect;
            actionLabel = 'Reconnect GitHub';
        }
        render(
            el('p', { class: 'github-line github-error', text: errorText(error) }),
            el('div', { class: 'github-actions' }, button(actionLabel, { primary: true, onClick: retry || connect })),
        );
    };

    // ---- flow --------------------------------------------------------------

    const connect = async () => {
        stopTimers();
        render(el('p', { class: 'github-line', text: 'Contacting GitHub…' }));
        const res = await send({ type: 'GITHUB_AUTH_BEGIN' });
        if (!res || res.phase === 'error') return renderError(res);
        renderConnecting(res);
        pollAuth();
    };

    const requestDisconnect = async retry => {
        const response = await send({ type: 'GITHUB_AUTH_DISCONNECT' });
        if (response && response.phase !== 'error' && response.connected === false) return true;
        const detail = response?.error?.message
            || 'The local GitHub connection could not be confirmed as removed. Reload Settings and try again.';
        renderError({ code: ERROR_CODES.UNKNOWN, message: detail }, retry);
        return false;
    };

    const cancelConnect = async () => {
        stopTimers();
        if (await requestDisconnect(cancelConnect)) await renderFromStatus();
    };

    const pollAuth = () => {
        stopPollTimer();
        pollTimer = setTimeout(async () => {
            const state = await send({ type: 'GITHUB_AUTH_STATE' });
            if (!state) return pollAuth();
            if (state.phase === 'polling') return pollAuth();
            if (state.phase === 'idle') return renderError('no-token');
            if (state.phase === 'error') return renderError(state);
            if (state.phase === 'authorized') return afterAuthorized();
            return pollAuth();
        }, 2000);
    };

    const afterAuthorized = async () => {
        stopTimers();
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!status || status.phase === 'error') {
            return renderError(status?.error || status, afterAuthorized);
        }
        if (status && status.connected) {
            const connected = rememberStatus({ ...status, permissionGranted: true });
            flash('GitHub connected');
            return renderConnected(connected);
        }
        const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
        if (discovery && discovery.phase === 'error') return renderError(discovery, afterAuthorized);
        const refreshed = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!refreshed || refreshed.phase === 'error') {
            return renderError(refreshed?.error || refreshed, afterAuthorized);
        }
        if (refreshed && refreshed.connected) {
            const connected = rememberStatus({ ...refreshed, permissionGranted: true });
            flash('GitHub connected');
            return renderConnected(connected);
        }
        return renderChooseRepo(rememberStatus({ ...(refreshed || status || {}), permissionGranted: true }), discovery);
    };

    const refreshRepos = async ({ choose = false } = {}) => {
        render(el('p', { class: 'github-line', text: 'Checking repository access…' }));
        const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
        if (discovery && discovery.phase === 'error') return renderError(discovery, refreshRepos);
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!status || status.phase === 'error') {
            return renderError(status?.error || status, refreshRepos);
        }
        const next = rememberStatus({ ...(status || {}), permissionGranted: true });
        if (!choose && next.connected) { flash('Repository selected'); return renderConnected(next); }
        return renderChooseRepo(next, discovery);
    };

    const selectRepo = async (repo, { confirmExisting = false } = {}) => {
        render(el('p', { class: 'github-line', text: 'Checking repository safety…' }));
        const status = await send({ type: 'GITHUB_AUTH_SELECT_REPO', repo, confirmExisting });
        if (status && status.connected) {
            const connected = rememberStatus({ ...status, permissionGranted: true });
            flash('Repository selected');
            return renderConnected(connected);
        }
        if (status && status.needsConfirmation) return renderExistingRepoConfirmation(repo);
        if (status?.phase === 'error') {
            return renderError(status.error || status, () => selectRepo(repo, { confirmExisting }));
        }
        if (status && status.error) {
            if ([
                ERROR_CODES.NETWORK,
                ERROR_CODES.RATE_LIMIT,
                ERROR_CODES.CONFLICT,
                ERROR_CODES.INVALID,
                ERROR_CODES.UNKNOWN,
            ].includes(status.error.code)) {
                return renderError(status.error, () => selectRepo(repo, { confirmExisting }), 'Try again');
            }
            return renderError(status.error, () => refreshRepos({ choose: true }), 'Choose another');
        }
        return refreshRepos({ choose: true });
    };

    const reconnect = async () => {
        stopTimers();
        if (await requestDisconnect(reconnect)) await ensureConnection();
    };

    const disconnect = async () => {
        stopTimers();
        if (await requestDisconnect(disconnect)) {
            flash('GitHub disconnected');
            await renderFromStatus();
        }
    };

    // Show the connection state for the current stored status.
    const renderFromStatus = async () => {
        if (permissionError) return renderPermissionDenied();
        detailEl.hidden = false;
        const permissionGranted = await hasGithubPermission(extensionApi);
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!status || status.phase === 'error') {
            return renderError(status?.error || status, renderFromStatus);
        }
        const next = rememberStatus({ ...(status || {}), permissionGranted });
        if (!permissionGranted) {
            stopTimers();
            return renderDisconnected();
        }
        if (next.connected) return renderConnected(next);
        if (next.hasToken) {
            const discovery = await send({ type: 'GITHUB_AUTH_DISCOVER' });
            if (discovery && discovery.phase === 'error') return renderError(discovery, renderFromStatus);
            const after = await send({ type: 'GITHUB_AUTH_STATUS' });
            if (!after || after.phase === 'error') {
                return renderError(after?.error || after, renderFromStatus);
            }
            const refreshed = rememberStatus({ ...(after || next), permissionGranted: true });
            if (refreshed.connected) return renderConnected(refreshed);
            return renderChooseRepo(refreshed, discovery);
        }
        return renderDisconnected();
    };

    // ---- toggle ------------------------------------------------------------

    async function ensureConnection() {
        permissionError = false;
        if (!(await hasGithubPermission(extensionApi))) {
            let granted = false;
            try {
                granted = await extensionApi.permissions.request({ origins: GITHUB_ORIGINS });
            } catch { granted = false; }
            if (!granted) {
                permissionError = true;
                renderPermissionDenied();
                return;
            }
        }
        const status = await send({ type: 'GITHUB_AUTH_STATUS' });
        if (!status || status.phase === 'error') {
            renderError(status?.error || status, ensureConnection);
            return;
        }
        if (status?.connected) {
            await renderFromStatus();
            return;
        }
        await connect();
    }

    enableEl.addEventListener('change', async () => {
        currentSettings = {
            ...currentSettings,
            enableGithubBackup: enableEl.checked,
            ...(!enableEl.checked && { autoGithubBackup: false }),
        };
        renderAscentStatus();
        await save({
            enableGithubBackup: enableEl.checked,
            ...(!enableEl.checked && { autoGithubBackup: false }),
        });
    });

    // This listener exists for exactly one reason: the user left for GitHub's
    // install or new-repository page and came back. It used to run on every
    // window focus, so with Settings open and ascent backup connected, each
    // alt-tab back to the browser cost one GitHub API request and a visible
    // "Checking…" flash — and could replace a confirmation mid-read.
    window.addEventListener('focus', () => {
        if (pollTimer || !awaitingGithubReturn) return;
        if (confirmingExistingRepo) return;
        awaitingGithubReturn = false;
        if (choosingRepo) void refreshRepos({ choose: true });
        else void renderFromStatus();
    });

    // Connection state comes from the background and browser permission API;
    // settings control only whether ascent-specific actions are exposed.
    let painted = false;
    return {
        populate(settings) {
            currentSettings = {
                enableGithubBackup: !!settings.enableGithubBackup,
                autoGithubBackup: !!settings.autoGithubBackup,
                removeGithubBackupOnDelete: !!settings.removeGithubBackupOnDelete,
            };
            enableEl.checked = currentSettings.enableGithubBackup;
            renderAscentStatus();
            if (!painted) {
                painted = true;
                if (!pollTimer) void renderFromStatus();
            }
        },
    };
}
