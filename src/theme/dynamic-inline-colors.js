// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Peakbagger's legacy markup frequently carries literal inline foreground and
// background colors. A static dark sheet cannot safely enumerate every spelling
// or future color. This focused dynamic layer follows Dark Reader's structural
// pattern: preserve the source declaration, put the dark result in an
// extension-owned custom property, activate it with a data attribute, and watch
// later DOM/style mutations. It intentionally handles only inline text and
// solid backgrounds; the site's authored stylesheet, images, and extension-
// owned controls keep their existing, explicitly reviewed theme owners.

export const INLINE_COLOR_ATTRIBUTE = 'data-bpb-dark-inline-color';
export const INLINE_BACKGROUND_ATTRIBUTE = 'data-bpb-dark-inline-bg';
export const INLINE_COLOR_PROPERTY = '--bpb-dark-inline-color';
export const INLINE_BACKGROUND_PROPERTY = '--bpb-dark-inline-bg';

const SOURCE_SELECTOR = '[style], [color], [bgcolor]';
const IGNORED_SELECTOR = [
    '.mainbanner',
    '.mainmenu',
    '[id^="bpb-"]',
    '[class^="bpb-"]',
    '[class*=" bpb-"]',
    '[id^="pbaf-"]',
    '[class^="pbaf-"]',
    '[class*=" pbaf-"]',
].join(', ');

const NAMED_COLORS = new Map(Object.entries({
    black: '#000000',
    silver: '#c0c0c0',
    gray: '#808080',
    grey: '#808080',
    white: '#ffffff',
    maroon: '#800000',
    red: '#ff0000',
    purple: '#800080',
    fuchsia: '#ff00ff',
    green: '#008000',
    lime: '#00ff00',
    olive: '#808000',
    yellow: '#ffff00',
    navy: '#000080',
    blue: '#0000ff',
    teal: '#008080',
    aqua: '#00ffff',
    orange: '#ffa500',
    brown: '#a52a2a',
    lightgray: '#d3d3d3',
    lightgrey: '#d3d3d3',
    transparent: '#00000000',
}));

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (start, end, amount) => start + (end - start) * amount;

const parseHex = value => {
    const match = /^#([0-9a-f]{3,8})$/i.exec(value);
    if (!match || ![3, 4, 6, 8].includes(match[1].length)) return null;
    const expanded = match[1].length <= 4
        ? match[1].split('').map(character => character + character).join('')
        : match[1];
    const hasAlpha = expanded.length === 8;
    return {
        r: parseInt(expanded.slice(0, 2), 16),
        g: parseInt(expanded.slice(2, 4), 16),
        b: parseInt(expanded.slice(4, 6), 16),
        a: hasAlpha ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
};

const parseRgbChannel = value => {
    const text = value.trim();
    const number = parseFloat(text);
    if (!Number.isFinite(number)) return null;
    return clamp(text.endsWith('%') ? number / 100 : number / 255) * 255;
};

const parseAlpha = value => {
    const text = value.trim();
    const number = parseFloat(text);
    if (!Number.isFinite(number)) return null;
    return clamp(text.endsWith('%') ? number / 100 : number);
};

const parseRgb = value => {
    const match = /^rgba?\((.*)\)$/i.exec(value);
    if (!match) return null;
    let channels;
    let alpha = '1';
    if (match[1].includes(',')) {
        const parts = match[1].split(',').map(part => part.trim());
        if (parts.length < 3 || parts.length > 4) return null;
        channels = parts.slice(0, 3);
        if (parts[3] != null) alpha = parts[3];
    } else {
        const [channelText, alphaText] = match[1].split('/').map(part => part.trim());
        channels = channelText.split(/\s+/);
        if (channels.length !== 3) return null;
        if (alphaText) alpha = alphaText;
    }
    const [r, g, b] = channels.map(parseRgbChannel);
    const a = parseAlpha(alpha);
    if ([r, g, b, a].some(component => component == null)) return null;
    return { r, g, b, a };
};

export const parseColor = (value, normalize = null) => {
    if (typeof value !== 'string') return null;
    let source = value.trim().toLowerCase();
    if (!source || source === 'currentcolor' || source.startsWith('var(')) return null;
    if (/^[0-9a-f]{3,8}$/i.test(source)) source = `#${source}`;
    source = NAMED_COLORS.get(source) || source;
    const direct = parseHex(source) || parseRgb(source);
    if (direct) return direct;
    if (typeof normalize !== 'function') return null;
    const normalized = normalize(value);
    if (!normalized || normalized.trim().toLowerCase() === source) return null;
    return parseColor(normalized);
};

const rgbToHsl = ({ r, g, b, a = 1 }) => {
    const channels = [r, g, b].map(value => clamp(value / 255));
    const max = Math.max(...channels);
    const min = Math.min(...channels);
    const delta = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    if (delta) {
        if (max === channels[0]) h = 60 * (((channels[1] - channels[2]) / delta) % 6);
        else if (max === channels[1]) h = 60 * ((channels[2] - channels[0]) / delta + 2);
        else h = 60 * ((channels[0] - channels[1]) / delta + 4);
    }
    return { h: h < 0 ? h + 360 : h, s, l, a };
};

const hslToRgb = ({ h, s, l, a = 1 }) => {
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const section = ((h % 360) + 360) % 360 / 60;
    const x = chroma * (1 - Math.abs(section % 2 - 1));
    const pairs = [
        [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
        [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
    ];
    const [rp, gp, bp] = pairs[Math.min(5, Math.floor(section))];
    const offset = l - chroma / 2;
    return {
        r: Math.round((rp + offset) * 255),
        g: Math.round((gp + offset) * 255),
        b: Math.round((bp + offset) * 255),
        a,
    };
};

const linearChannel = value => {
    const channel = clamp(value / 255);
    return channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4);
};

export const relativeLuminance = ({ r, g, b }) =>
    0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);

export const contrastRatio = (foreground, background) => {
    const alpha = foreground.a == null ? 1 : clamp(foreground.a);
    const composited = {
        r: foreground.r * alpha + background.r * (1 - alpha),
        g: foreground.g * alpha + background.g * (1 - alpha),
        b: foreground.b * alpha + background.b * (1 - alpha),
    };
    const [lighter, darker] = [
        relativeLuminance(composited),
        relativeLuminance(background),
    ].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
};

const REFERENCE_BACKGROUND = { r: 32, g: 34, b: 36, a: 1 };
const MINIMUM_TEXT_CONTRAST = 4.5;

const ensureTextContrast = hsl => {
    let result = hslToRgb(hsl);
    if (contrastRatio(result, REFERENCE_BACKGROUND) >= MINIMUM_TEXT_CONTRAST) return result;
    let low = hsl.l;
    let high = 1;
    for (let index = 0; index < 12; index += 1) {
        const lightness = (low + high) / 2;
        const candidate = hslToRgb({ ...hsl, l: lightness });
        if (contrastRatio(candidate, REFERENCE_BACKGROUND) >= MINIMUM_TEXT_CONTRAST) {
            high = lightness;
            result = candidate;
        } else {
            low = lightness;
        }
    }
    return result;
};

export const transformForeground = color => {
    const source = rgbToHsl(color);
    const neutral = source.s < 0.16 || source.l < 0.08;
    let h = neutral ? 35 : source.h;
    let s = neutral ? 0.08 : Math.min(source.s, 0.68);
    if (!neutral && h >= 205 && h <= 245) {
        h = mix(205, 220, (h - 205) / 40);
        s = Math.min(s, 0.55);
    }
    const l = source.l <= 0.5
        ? mix(0.78, 0.60, source.l / 0.5)
        : mix(0.60, 0.90, (source.l - 0.5) / 0.5);
    return ensureTextContrast({ h, s, l, a: source.a });
};

export const transformBackground = color => {
    const source = rgbToHsl(color);
    const neutral = source.s < 0.16;
    const h = neutral ? 210 : source.h;
    const s = neutral ? 0.06 : Math.min(source.s, 0.55);
    const l = source.l <= 0.5
        ? mix(0.05, 0.26, source.l / 0.5)
        : mix(0.26, 0.13, (source.l - 0.5) / 0.5);
    return hslToRgb({ h, s, l, a: source.a });
};

export const formatColor = ({ r, g, b, a = 1 }) => {
    const channels = [r, g, b].map(value => Math.round(clamp(value, 0, 255)));
    return a < 1
        ? `rgba(${channels.join(', ')}, ${Math.round(clamp(a) * 1000) / 1000})`
        : `rgb(${channels.join(', ')})`;
};

const createCanvasNormalizer = document => {
    let context;
    let unavailable = false;
    return value => {
        if (unavailable) return null;
        try {
            context ||= document.createElement('canvas').getContext('2d');
            if (!context) {
                unavailable = true;
                return null;
            }
            context.fillStyle = '#010203';
            context.fillStyle = value;
            const first = context.fillStyle;
            context.fillStyle = '#040506';
            context.fillStyle = value;
            const second = context.fillStyle;
            return first === '#010203' && second === '#040506' ? null : first;
        } catch {
            unavailable = true;
            return null;
        }
    };
};

export const createDynamicInlineColorApplier = ({
    document,
    MutationObserver = document?.defaultView?.MutationObserver,
    normalizeColor = createCanvasNormalizer(document),
} = {}) => {
    const root = document?.documentElement;
    const ElementClass = document?.defaultView?.Element;
    const transformedCache = {
        foreground: new Map(),
        background: new Map(),
    };
    let observer = null;
    let active = false;

    const transformed = (value, role) => {
        const cache = transformedCache[role];
        if (cache.has(value)) return cache.get(value);
        const parsed = parseColor(value, normalizeColor);
        const result = parsed
            ? formatColor(role === 'foreground'
                ? transformForeground(parsed)
                : transformBackground(parsed))
            : null;
        cache.set(value, result);
        return result;
    };

    const clearOverride = (element, attribute, property) => {
        element.removeAttribute(attribute);
        element.style?.removeProperty(property);
    };

    const setOverride = (element, attribute, property, value) => {
        if (!value) {
            clearOverride(element, attribute, property);
            return;
        }
        if (element.style.getPropertyValue(property) !== value) {
            element.style.setProperty(property, value);
        }
        if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '');
    };

    const ignored = element =>
        element.matches('iframe, style, script, link')
        || element.closest(IGNORED_SELECTOR) != null;

    const processElement = element => {
        if (!ElementClass || !(element instanceof ElementClass) || !element.style) return;
        if (ignored(element)) {
            clearOverride(element, INLINE_COLOR_ATTRIBUTE, INLINE_COLOR_PROPERTY);
            clearOverride(element, INLINE_BACKGROUND_ATTRIBUTE, INLINE_BACKGROUND_PROPERTY);
            return;
        }

        const attributeColor = element.getAttribute('color') || '';
        const foreground = element.style.getPropertyValue('color') || attributeColor;
        const background = element.style.getPropertyValue('background-color')
            || element.getAttribute('bgcolor')
            || '';

        setOverride(
            element,
            INLINE_COLOR_ATTRIBUTE,
            INLINE_COLOR_PROPERTY,
            foreground ? transformed(foreground, 'foreground') : null,
        );
        setOverride(
            element,
            INLINE_BACKGROUND_ATTRIBUTE,
            INLINE_BACKGROUND_PROPERTY,
            background ? transformed(background, 'background') : null,
        );
    };

    const processTree = node => {
        if (!ElementClass || !(node instanceof ElementClass)) return;
        if (node.matches(SOURCE_SELECTOR)) processElement(node);
        node.querySelectorAll(SOURCE_SELECTOR).forEach(processElement);
    };

    const start = () => {
        if (active || !root || !MutationObserver) return;
        active = true;
        processTree(root);
        observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') processElement(mutation.target);
                else mutation.addedNodes.forEach(processTree);
            }
        });
        observer.observe(root, {
            attributes: true,
            attributeFilter: ['style', 'color', 'bgcolor', 'class', 'id'],
            childList: true,
            subtree: true,
        });
    };

    const stop = () => {
        active = false;
        observer?.disconnect();
        observer = null;
    };

    return {
        setTheme(theme) {
            if (theme === 'dark') start();
            else stop();
        },
        disconnect: stop,
    };
};
