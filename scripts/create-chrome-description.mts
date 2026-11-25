import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_PATH = 'store-assets/description.md';
const OUTPUT_PATH = 'store-assets/description-chrome.txt';

function convertStandaloneLink(block: string): string | null {
    const match = block.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)\.?$/);
    if (!match) return null;

    const label = match[1].replace(/[.:]\s*$/, '');
    assertPlainText(label);
    return `${label}:\n${match[2]}`;
}

function convertList(block: string): string | null {
    const lines = block.split('\n');
    const converted = lines.map((line) => {
        const match = line.match(/^- \*\*(.+?):\*\*\s+(.+)$/);
        if (!match) return null;
        assertPlainText(match[1]);
        assertPlainText(match[2]);
        return `• ${match[1]} — ${match[2]}`;
    });

    return converted.every(Boolean) ? converted.join('\n\n') : null;
}

function assertPlainText(block: string): void {
    const unsupportedMarkdown = [
        /\*\*|__/,
        /!\[[^\]]*\]\([^)]+\)/,
        /\[[^\]]+\]\([^)]+\)/,
        /^#{1,6}\s/m,
        /^[-*+]\s/m,
        /`/,
        /<\/?[a-z][^>]*>/i,
    ];
    if (unsupportedMarkdown.some((pattern) => pattern.test(block))) {
        throw new Error(`Unsupported Markdown in Chrome description block: ${block}`);
    }
}

export function convertChromeDescription(markdown: string): string {
    if (typeof markdown !== 'string' || markdown.trim() === '') {
        throw new Error(`${SOURCE_PATH} must contain the listing description`);
    }

    const blocks = markdown
        .replace(/\r\n?/g, '\n')
        .trim()
        .split(/\n{2,}/)
        .map((block) => block.trim());

    const converted = blocks.map((block, index) => {
        const list = convertList(block);
        if (list) return list;

        const link = convertStandaloneLink(block);
        if (link) return link;

        const strong = block.match(/^\*\*(.+)\*\*$/);
        if (strong) {
            const text = strong[1];
            assertPlainText(text);
            const isSectionHeading = index > 0 && !/[.!?]$/.test(text);
            return isSectionHeading ? text.toUpperCase() : text;
        }

        assertPlainText(block);
        return block.replace(/\n/g, ' ');
    });

    return `${converted.join('\n\n')}\n`;
}

async function main(): Promise<void> {
    const markdown = await readFile(SOURCE_PATH, 'utf8');
    const description = convertChromeDescription(markdown);
    await writeFile(OUTPUT_PATH, description);
    console.log(`Wrote Chrome listing description to ${OUTPUT_PATH}.`);
}

const isCli = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
