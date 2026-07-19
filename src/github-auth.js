// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — GitHub App device-flow auth and token/repo storage.
//
// "OAuth to one repo" is a registered GitHub App (device flow on, no webhook,
// repository permission Contents: read and write, no client secret) plus a
// user-chosen installation. Only the app's public client_id ships here. Both
// device-flow endpoints take the client_id alone — unlike the web application
// flow, whose token exchange needs a client secret — so no secret exists to
// leak. See docs/github-ascent-backup.md.
//
// Two pieces live here:
//
//   createDeviceFlow({ fetch }) — the device-flow client: request a user code,
//   then poll for the user access token, honoring the server interval and any
//   slow_down. It performs I/O only through an injected fetch (and injectable
//   wait/now), so it is unit-testable without network or real timers and holds
//   no ambient credentials.
//
//   authStore — the token/repo accessor over chrome.storage.local. The token
//   must never ride storage.sync (secrets must not sync onto every signed-in
//   browser), which also keeps it outside src/settings.js's sync schema. The
//   background worker is the only holder; content scripts never receive it.
//   Disconnect drops the local token; full revocation is uninstalling the app.
//
// Idempotent: safe to inject more than once into the same global.

    // The registered Better Peakbagger backup app. Public by design.
    const CLIENT_ID = 'Iv23liZpTdD1iZfT3eL1';
    // The app's public URL name (github.com/apps/<slug>), used to hand the user
    // to GitHub's own repository-scoping UI at install time.
    const APP_SLUG = 'better-peakbagger-backup';
    const INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
    const APP_URL = `https://github.com/apps/${APP_SLUG}`;
    const DEVICE_CODE_URL = 'https://github.com/login/device/code';
    const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
    // Where the user types the shown code.
    const VERIFICATION_URI = 'https://github.com/login/device';
    const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

    const AUTH_ERROR_CODES = Object.freeze({
        NETWORK: 'network',
        DEVICE_FLOW_DISABLED: 'device-flow-disabled',
        DENIED: 'denied',                 // the user rejected the authorization
        EXPIRED: 'expired',               // the user code lapsed before approval
        CANCELLED: 'cancelled',           // the extension aborted the wait
        UNSUPPORTED: 'unsupported',
        UNKNOWN: 'unknown',
    });

    class GithubAuthError extends Error {
        constructor(code, message) {
            super(message || code);
            this.name = 'GithubAuthError';
            this.code = code;
        }
    }

    const defaultWait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const defaultNow = () => Date.now();

    // The device-flow OAuth errors GitHub returns in the token-poll body, mapped
    // to our stable codes. authorization_pending and slow_down are handled by
    // the poll loop and never reach here.
    const mapOAuthError = error => {
        switch (error) {
            case 'access_denied': return AUTH_ERROR_CODES.DENIED;
            case 'expired_token': return AUTH_ERROR_CODES.EXPIRED;
            case 'device_flow_disabled': return AUTH_ERROR_CODES.DEVICE_FLOW_DISABLED;
            case 'unsupported_grant_type': return AUTH_ERROR_CODES.UNSUPPORTED;
            default: return AUTH_ERROR_CODES.UNKNOWN;
        }
    };

    const createDeviceFlow = ({ fetch, clientId = CLIENT_ID, wait = defaultWait, now = defaultNow } = {}) => {
        if (typeof fetch !== 'function') throw new TypeError('device flow requires an injected fetch');

        // github.com's device endpoints default to form-encoded responses; ask
        // for JSON explicitly and send form-encoded bodies (the documented shape
        // that does not depend on CORS-preflighted JSON content types).
        const post = async (url, params) => {
            let res;
            try {
                res = await fetch(url, {
                    method: 'POST',
                    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(params).toString(),
                });
            } catch (cause) {
                throw new GithubAuthError(AUTH_ERROR_CODES.NETWORK, 'Could not reach GitHub.');
            }
            let text = '';
            try { text = await res.text(); } catch { text = ''; }
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            if (!res || !res.ok || !json) {
                throw new GithubAuthError(AUTH_ERROR_CODES.NETWORK, 'GitHub returned an unexpected response.');
            }
            return json;
        };

        // Step 1: ask GitHub for a user_code and device_code.
        const requestCode = async () => {
            const data = await post(DEVICE_CODE_URL, { client_id: clientId });
            if (data.error) throw new GithubAuthError(mapOAuthError(data.error), data.error_description);
            return {
                deviceCode: data.device_code,
                userCode: data.user_code,
                verificationUri: data.verification_uri || VERIFICATION_URI,
                verificationUriComplete: data.verification_uri_complete || null,
                expiresIn: Number(data.expires_in) || 900,
                interval: Number(data.interval) || 5,
            };
        };

        // Perform one token-endpoint request. The background worker uses this
        // one-shot form so each options-page message can advance a persisted
        // device flow without relying on an MV3 worker staying alive.
        const pollTokenOnce = async code => {
            const data = await post(ACCESS_TOKEN_URL, {
                client_id: clientId,
                device_code: code.deviceCode,
                grant_type: DEVICE_GRANT,
            });
            if (data.access_token) {
                return {
                    phase: 'authorized',
                    credential: { token: data.access_token, tokenType: data.token_type || 'bearer', scope: data.scope || '' },
                };
            }
            if (data.error === 'authorization_pending') return { phase: 'pending' };
            if (data.error === 'slow_down') return { phase: 'slow-down', interval: Number(data.interval) || 0 };
            throw new GithubAuthError(mapOAuthError(data.error), data.error_description);
        };

        // Step 2: poll for the token, honoring the server interval and any
        // slow_down, until the user approves or the code expires. `signal`
        // (optional) lets non-worker callers cancel a pending authorization.
        const pollForToken = async (code, { signal = null } = {}) => {
            let interval = Math.max(1, Number(code.interval) || 5);
            const deadline = now() + (Number(code.expiresIn) || 900) * 1000;
            for (;;) {
                if (signal && signal.aborted) throw new GithubAuthError(AUTH_ERROR_CODES.CANCELLED, 'Authorization cancelled.');
                await wait(interval * 1000);
                if (signal && signal.aborted) throw new GithubAuthError(AUTH_ERROR_CODES.CANCELLED, 'Authorization cancelled.');
                if (now() > deadline) throw new GithubAuthError(AUTH_ERROR_CODES.EXPIRED, 'The authorization code expired.');
                const result = await pollTokenOnce(code);
                if (result.phase === 'authorized') return result.credential;
                if (result.phase === 'pending') continue;
                if (result.phase === 'slow-down') {
                    // Add the server's advice (or the documented +5s) to the interval.
                    interval = Math.max(interval + 5, result.interval);
                    continue;
                }
            }
        };

        // The whole handshake: request a code, hand it to the UI via onCode, and
        // resolve with the token once the user approves.
        const authorize = async ({ onCode, signal } = {}) => {
            const code = await requestCode();
            if (typeof onCode === 'function') onCode(code);
            return pollForToken(code, { signal });
        };

        return { requestCode, pollTokenOnce, pollForToken, authorize };
    };

    // ---- Installation / repository discovery -------------------------------

    const API_ROOT = 'https://api.github.com';

    // A GET against the GitHub REST API with the user token. A dead token
    // surfaces as EXPIRED so the UI prompts a reconnect; anything else is
    // network/unknown. Discovery is best-effort read-only.
    const apiGetResponse = async (fetch, token, path) => {
        const url = new URL(path, API_ROOT);
        if (url.origin !== API_ROOT) throw new GithubAuthError(AUTH_ERROR_CODES.UNKNOWN, 'GitHub returned an invalid pagination link.');
        let res;
        try {
            res = await fetch(url.href, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
        } catch {
            throw new GithubAuthError(AUTH_ERROR_CODES.NETWORK, 'Could not reach GitHub.');
        }
        if (res.status === 401) throw new GithubAuthError(AUTH_ERROR_CODES.EXPIRED, 'The GitHub authorization is no longer valid.');
        let text = '';
        try { text = await res.text(); } catch { text = ''; }
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!res.ok || !json) throw new GithubAuthError(AUTH_ERROR_CODES.UNKNOWN, 'GitHub returned an unexpected response.');
        return { json, link: res.headers && typeof res.headers.get === 'function' ? res.headers.get('link') : null };
    };

    const apiGet = async (fetch, token, path) => (await apiGetResponse(fetch, token, path)).json;

    const nextPage = link => {
        if (!link) return null;
        for (const part of link.split(',')) {
            const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part);
            if (match && match[2].split(/\s+/).includes('next')) return match[1];
        }
        return null;
    };

    const apiGetAll = async (fetch, token, path, key) => {
        const items = [];
        const seen = new Set();
        let next = path;
        while (next) {
            const url = new URL(next, API_ROOT);
            if (seen.has(url.href)) throw new GithubAuthError(AUTH_ERROR_CODES.UNKNOWN, 'GitHub returned a pagination loop.');
            seen.add(url.href);
            const page = await apiGetResponse(fetch, token, url.href);
            if (Array.isArray(page.json[key])) items.push(...page.json[key]);
            next = nextPage(page.link);
        }
        return items;
    };

    // The account login behind the token, for a human-readable connected state.
    const fetchAccount = async ({ fetch, token }) => {
        const user = await apiGet(fetch, token, '/user');
        return { login: user.login || '', id: user.id ?? null };
    };

    // Every repository the user granted this app, across its installations.
    // Repo scoping happened at install time ("Only select repositories"), so
    // this is exactly the set the token can write to. Returns the count of the
    // app's installations too, so the UI can tell "none granted" (link to
    // install) from "installed but no repos".
    const listBackupRepositories = async ({ fetch, token, appSlug = APP_SLUG }) => {
        const owned = await apiGetAll(fetch, token, '/user/installations?per_page=100', 'installations');
        const installations = owned.filter(inst => inst.app_slug === appSlug);
        const repos = [];
        for (const inst of installations) {
            const granted = await apiGetAll(fetch, token, `/user/installations/${inst.id}/repositories?per_page=100`, 'repositories');
            for (const repo of granted) {
                repos.push({
                    owner: repo.owner && repo.owner.login,
                    name: repo.name,
                    fullName: repo.full_name,
                    id: repo.id,
                    defaultBranch: repo.default_branch || 'main',
                    installationId: inst.id,
                });
            }
        }
        return { installationCount: installations.length, repos };
    };

    // ---- Token / repo storage (chrome.storage.local only) ------------------

    const STORAGE_KEY = 'bpbGithubAuth';

    const resolveLocalArea = () => {
        const api = (typeof browser !== 'undefined' && browser.storage) ? browser
            : (typeof chrome !== 'undefined' && chrome.storage) ? chrome : null;
        return api && api.storage && api.storage.local ? api.storage.local : null;
    };

    // The accessor is built over an injectable storage area so it is testable
    // without a browser; the default binds chrome.storage.local at call time.
    const createAuthStore = (area = resolveLocalArea()) => {
        const read = async () => {
            if (!area) return null;
            try {
                const res = await area.get(STORAGE_KEY);
                const value = res && res[STORAGE_KEY];
                return value && typeof value === 'object' ? value : null;
            } catch { return null; }
        };
        const write = async patch => {
            if (!area) return null;
            const next = { ...(await read()), ...patch };
            try { await area.set({ [STORAGE_KEY]: next }); } catch { /* storage unavailable */ }
            return next;
        };
        return {
            STORAGE_KEY,
            read,
            // The credential half; the token stays local and is only ever held
            // by the background worker.
            setCredential: ({ token, tokenType = 'bearer', scope = '' }) =>
                write({ token, tokenType, scope, grantedAt: new Date().toISOString() }),
            setAccount: account => write({ account: account || null }),
            setRepo: repo => write({ repo: repo || null }),
            setInstallationId: installationId => write({ installationId: installationId ?? null }),
            getToken: async () => (await read())?.token || null,
            getRepo: async () => (await read())?.repo || null,
            isConnected: async () => {
                const value = await read();
                return !!(value && value.token && value.repo && value.repo.owner && value.repo.name);
            },
            // Disconnect: drop the local token and every derived choice. This
            // does not revoke on GitHub — that is uninstalling the app.
            clear: async () => {
                if (!area) return;
                try { await area.remove(STORAGE_KEY); } catch { /* storage unavailable */ }
            },
        };
    };

    const authStore = createAuthStore();

    const API = {
        CLIENT_ID,
        APP_SLUG,
        INSTALL_URL,
        APP_URL,
        VERIFICATION_URI,
        AUTH_ERROR_CODES,
        GithubAuthError,
        createDeviceFlow,
        fetchAccount,
        listBackupRepositories,
        createAuthStore,
        authStore,
    };

    export const githubAuth = API;
