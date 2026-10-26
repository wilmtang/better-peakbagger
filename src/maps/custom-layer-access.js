// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
const api = globalThis.browser || globalThis.chrome, token = location.hash.slice(1), allow = document.getElementById('allow'), status = document.getElementById('status');
let origins = [], ready = false, busy = false;
document.getElementById('close').onclick = () => window.close();
void api.runtime.sendMessage({ type: 'CUSTOM_PRIVATE_REVIEW', token }).then(reply => {
    if (!reply?.ok) throw new Error('This request expired. Open approval again from the map.');
    origins = reply.origins.map(origin => `https://${new URL(origin).hostname}/*`);
    document.getElementById('source').textContent = reply.name;document.getElementById('hosts').textContent = reply.origins.join(' · ');
    ready = true;allow.setAttribute('aria-disabled', 'false');
}).catch(error => { status.textContent = error.message; });
allow.onclick = async event => {
    if (!event.isTrusted || !ready || busy) return;
    busy = true;allow.setAttribute('aria-disabled', 'true');allow.setAttribute('aria-busy', 'true');status.textContent = 'Waiting for provider access…';
    try {
        // Preserve this explicit extension-surface user activation.
        if (!await api.permissions.request({ origins })) throw new Error('Provider access wasn’t granted. You can try again.');
        const reply = await api.runtime.sendMessage({ type: 'CUSTOM_PRIVATE_APPROVE', token });
        if (!reply?.ok) throw new Error(reply?.error || 'Approval expired. Open it again from the map.');
        status.textContent = 'Approved. Return to the map and choose Retry.';ready = false;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false;allow.removeAttribute('aria-busy');allow.setAttribute('aria-disabled', String(!ready)); }
};
