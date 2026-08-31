// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const pointerEvent = (dom, type, {
    pointerId = 1,
    pointerType = 'mouse',
    ...init
} = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: pointerType },
    });
    return event;
};
