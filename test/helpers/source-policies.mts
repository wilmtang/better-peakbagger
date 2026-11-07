// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RuntimeSource } from './runtime-sources.mts';

const matches = (source: RuntimeSource, pattern: RegExp) => source.variants.some(text => pattern.test(text));
const finding = (source: RuntimeSource, message: string) => `${source.file} ${message}`;
export function unitConstantFindings(source: RuntimeSource): string[] {
    return source.file !== 'src/ui/units.js' && matches(source, /3\.28084|1609\.344/)
        ? [finding(source, 'hardcodes a conversion constant instead of importing src/ui/units.js')] : [];
}
const settingsPatterns = [
    {pattern: /#d9483b/i, what: 'the default route color'},
    {pattern: /casingWidth:\s*9\b/, what: 'the default casing width'},
    {pattern: /\b(?:1,\s*12|3,\s*20|240,\s*720)\b/, what: 'a route/viewport bound pair'},
    {pattern: /\blet\s+pref\s*=\s*['"]system['"]/, what: 'the default theme preference'},
    {pattern: /\b(?:showSunMoon|showWeather|showSnotel)\s*:\s*(?:true|false)\b/, what: 'a section display default'},
    {pattern: /\['BLM',\s*'USFS',\s*'FED',\s*'STAT',\s*'LOC',\s*'TRIB',\s*'CROWN'/, what: 'the default land type selection'},
];
export function settingsDefaultFindings(source: RuntimeSource): string[] {
    return source.file === 'src/settings/settings-schema.ts' ? [] : settingsPatterns
        .filter(({pattern}) => matches(source, pattern)).map(({what}) => finding(source, `hardcodes ${what}`));
}
export function uploadLimitFindings(source: RuntimeSource): string[] {
    const pattern = /(?:points?|waypoints?|segments?)\w*\.length\s*[<>]=?\s*(?:3000|50)\b|[<>]=?\s*(?:3000|50)\b\s*(?:\)|;).*(?:point|segment)/i;
    return source.file !== 'src/capture/upload-limits.js' && matches(source, pattern)
        ? [finding(source, 'hardcodes a Peakbagger upload limit')] : [];
}
export function cloudflareFindings(source: RuntimeSource): string[] {
    if (source.file === 'src/peakbagger/peakbagger-cloudflare.js') return [];
    const findings = [];
    // Provider response classification owns its documented response marker,
    // but must never take over Peakbagger's human-check copy.
    if (source.file !== 'src/capture/provider-response.js' && matches(source, /cf-mitigated|_cf_chl_opt|cf-chl-|challenge-platform|Just a moment/)) {
        findings.push(finding(source, 'duplicates Cloudflare classification'));
    }
    if (matches(source, /Peakbagger is asking for a human check|Complete check on Peakbagger/)) findings.push(finding(source, 'duplicates Peakbagger human-check copy'));
    return findings;
}
export function originFindings(source: RuntimeSource): string[] {
    const findings = new Set<string>();
    for (const text of source.variants) for (const line of text.split('\n')) {
        if (/https:\/\/peakbagger\.com/i.test(line)) findings.add(finding(source, 'uses the non-canonical absolute origin'));
        if (source.file === 'src/peakbagger/peakbagger-origin.js') continue;
        const isPattern = /\/[^/\n]*peakbagger\\?\.com[^/\n]*\/[gimsuy]*/i.test(line) && !line.includes('https://') && !line.includes('http://');
        const isHostSet = /new Set\(\[[^\]]*peakbagger\.com/i.test(line);
        if ((isPattern || isHostSet) && /peakbagger\\?\.com/i.test(line)) findings.add(finding(source, 'duplicates the host check'));
    }
    return [...findings];
}
export const DEADLINE_EXCEPTION_FILES = ['src/maps/peak-markers.js'] as const;
export function directFetch(source: RuntimeSource): boolean {return matches(source, /\bfetch\s*(?:\?\.)?\s*\(/);}
export function deadlineFindings(source: RuntimeSource): string[] {
    const findings = [];
    if (directFetch(source) && !matches(source, /request-deadline\.[cm]?[jt]s/)) {
        const exception = source.file === DEADLINE_EXCEPTION_FILES[0]
            && matches(source, /setTimeout\(\(\) => controller\.abort\(\), REQUEST_TIMEOUT_MS\)/)
            && matches(source, /readBoundedResponseText\(response/) && matches(source, /clearTimeout\(timeout\)/);
        if (!exception) findings.push(finding(source, 'directly calls fetch without the shared deadline'));
    }
    if (source.file !== 'src/net/request-deadline.js' && matches(source, /Promise\.race\s*\(\s*\[[^\]]*\btimeout\b/i)) {
        findings.push(finding(source, 'hardcodes its own race-with-timeout'));
    }
    return findings;
}
export function settingsReadCounts(sources: RuntimeSource[], method: 'get' | 'requireCurrent'): Record<string, number> {
    const found: Record<string, number> = {};
    const expression = new RegExp(`\\b(?:Settings|S|settings|photoBackupSettings|preferences)\\.${method}\\s*(?:\\?\\.)?\\s*\\(`, 'g');
    for (const source of sources) {
        // Variants represent the same module. Count it once, with erased type
        // parameters exposing calls that the original regex could not see.
        const count = Math.max(...source.variants.map(text => (text.match(expression) || []).length));
        if (count) found[source.file] = count;
    }
    return found;
}
