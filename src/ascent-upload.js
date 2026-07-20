// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ascent-editor upload conveniences (isolated world, ascentedit.aspx).
// A fresh "Add Ascent" form gets today's date filled in; an existing ascent
// being edited arrives with its date populated and is never touched — the
// if-empty guard is the create/edit discriminator. The capture draft flow
// sets the date unconditionally after its handshake, so this autofill can
// never corrupt a prepared draft.

(() => {
    'use strict';

    const pad = value => String(value).padStart(2, '0');

    const localToday = (nowDate = new Date()) =>
        `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;

    const autofillDate = () => {
        const field = document.getElementById('DateText');
        if (!field || String(field.value || '').trim()) return false;
        field.value = localToday();
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };

    autofillDate();
})();
