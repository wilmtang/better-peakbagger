// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

const element = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class' && value != null) node.className = value;
        else if (key === 'text' && value !== undefined) node.textContent = value;
        else if (key === 'checked') node.checked = !!value;
        else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2), value);
        } else if (value != null) {
            node.setAttribute(key, value);
        }
    }
    for (const child of [].concat(children)) if (child) node.appendChild(child);
    return node;
};

export const dom = { element };
