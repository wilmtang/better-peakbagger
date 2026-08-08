const RELEASE_HEADING = /^## (\d+\.\d+\.\d+)(?:\s|$)/gm;

function sectionBounds(changelog, headingPattern) {
    const match = headingPattern.exec(changelog);
    if (!match) return null;

    const nextHeading = changelog.indexOf('\n## ', match.index + match[0].length);
    return {
        start: match.index,
        end: nextHeading === -1 ? changelog.length : nextHeading + 1,
        match,
    };
}

export function releasedVersions(changelog) {
    return [...changelog.matchAll(RELEASE_HEADING)].map((match) => match[1]);
}

export function releaseSection(changelog, version) {
    const escapedVersion = version.replaceAll('.', '\\.');
    const bounds = sectionBounds(
        changelog,
        new RegExp(`^## ${escapedVersion}(?:\\s|$)`, 'm'),
    );
    return bounds ? changelog.slice(bounds.start, bounds.end) : null;
}

export function stampUnreleased(changelog, version, date) {
    const headings = [...changelog.matchAll(/^## Unreleased$/gm)];
    if (headings.length !== 1) {
        throw new Error(headings.length === 0
            ? "CHANGELOG.md has no '## Unreleased' heading to stamp."
            : "CHANGELOG.md has more than one '## Unreleased' heading.");
    }
    if (releaseSection(changelog, version)) {
        throw new Error(`CHANGELOG.md already has a release heading for ${version}.`);
    }

    const bounds = sectionBounds(changelog, /^## Unreleased$/m);
    const body = changelog.slice(
        bounds.start + bounds.match[0].length,
        bounds.end,
    ).trim();
    if (!body) {
        throw new Error("CHANGELOG.md '## Unreleased' section is empty.");
    }

    return `${changelog.slice(0, bounds.start)}## Unreleased\n\n`
        + `## ${version} — ${date}`
        + changelog.slice(bounds.start + bounds.match[0].length);
}

export function assertReleasedSectionsUnchanged(currentChangelog, taggedChangelogs) {
    for (const [version, taggedChangelog] of Object.entries(taggedChangelogs)) {
        const currentSection = releaseSection(currentChangelog, version);
        const taggedSection = releaseSection(taggedChangelog, version);
        if (!taggedSection) {
            throw new Error(`Tag v${version} has no changelog section for ${version}.`);
        }
        if (currentSection !== taggedSection) {
            throw new Error(`Released changelog section ${version} differs from tag v${version}.`);
        }
    }
}
