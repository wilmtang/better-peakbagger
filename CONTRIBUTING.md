# Contributing to Better Peakbagger

Thanks for helping improve Better Peakbagger. Bug reports, documentation,
tests, design feedback, and code contributions are welcome. Please keep
discussions respectful and focused on making the extension better for its users.

## 1. Pull requests and AI review

AI-assisted coding is welcome. Before opening a pull request, have a current
frontier AI model review the complete proposed PR diff. Give it the relevant
surrounding code and [AGENTS.md](AGENTS.md), and ask it to check for:

- Correctness, edge cases, and missing regression coverage.
- Consistency with the codebase's conventions, architecture, and agent instructions.
- Privacy, security, and unintended changes to existing behavior.

Use a separate review pass, even when AI helped write the implementation.
Evaluate the findings and address valid issues before submitting. You remain
responsible for understanding, explaining, and testing your contribution; AI
review supplements your own review and verification. Do not send secrets or
private user data to a model.

Keep each pull request focused on one problem and target `main`. Include the
problem being solved, the resulting behavior, any related issue or discussion,
and the checks you actually ran. Note any verification gaps and briefly summarize
the AI review and significant findings you addressed. For interface changes,
include screenshots or a short recording.

### New feature pull requests

Before implementing a substantial new feature or changing an existing workflow,
please open an [issue](https://github.com/wilmtang/better-peakbagger/issues)
or start a [discussion](https://github.com/wilmtang/better-peakbagger/discussions)
with the maintainer. Explain the problem you want to solve, who it helps, and
the approach you have in mind. Screenshots or a small mockup can help.

Early discussion helps establish whether an idea fits the project and avoids
spending time on an implementation that needs a different direction. Small bug
fixes and documentation corrections can usually go straight to a pull request.
Check existing issues, discussions, and pull requests before starting work.

Explain how the feature fits the agreed scope and any tradeoffs in the PR.
Update the relevant documentation when behavior or setup changes.

### Bug reports and bug-fix pull requests

You can report a bug through [GitHub Issues](https://github.com/wilmtang/better-peakbagger/issues)
without providing a fix. Include enough information for someone else to reproduce
the problem:

- Your browser, operating system, and extension version.
- The affected page or feature and the steps that trigger the problem.
- What you expected and what actually happened.
- Relevant screenshots or error messages, with private information removed.

Use a small, anonymized example when a report needs a GPX file or page fixture.
Do not post credentials, session cookies, private activity data, or unredacted
account exports.

For a bug-fix PR, identify the root cause and make the smallest safe change.
Describe how you reproduced the bug and verified the fix. Add a regression test
when practical, and demonstrate that it fails for the original defect and passes
with the fix. Explain any gaps when reproduction or regression coverage is not
possible. Keep unrelated cleanup out of the fix.

## 2. Development setup and workflow

### Set up your environment

1. Fork the repository and create a branch from `main` for your change.
2. Install Node.js 22 or newer and npm; CI uses Node.js 24.
3. Run `npm ci` to install the locked dependencies and repository Git hooks.
4. Read [AGENTS.md](AGENTS.md), the [architecture guide](docs/architecture.md),
   and the [development guide](docs/development.md) before changing code.

Build the extension with `npm run build`. Load the generated `dist/` directory
in your browser, never the repository root. The development guide covers
browser setup, managed watch commands, and verification prerequisites.

### Make your change

- Inspect the existing implementation and follow the conventions of the
  surrounding code. Avoid unrelated refactors, formatting changes, and
  dependency updates.
- Edit source files and build inputs rather than generated files in `dist/`.
  Put modules and tests in the directories that own the behavior.
- Place focused tests beside the affected behavior.
- Preserve the consent, data-handling, and manual Save boundaries described in
  [AGENTS.md](AGENTS.md) and [PRIVACY.md](PRIVACY.md).
- For interface changes, follow the repository's UI/UX guidance. Inspect the
  rendered result in Chrome and Firefox, including narrow layouts, relevant
  themes, keyboard use, and loading, error, and retry states. Check for layout
  shifts as well as correct behavior.
- Update documentation when behavior, setup, or architecture changes.

Keep commits focused and independently reviewable. Use lowercase Conventional
Commit subjects, such as `fix: preserve draft after failed upload` or
`docs: clarify firefox setup`. Add a body when context, constraints, or
verification results need explanation.

### Verify your work

For code changes, run the standard checks:

```sh
npm test
npm run test:scale
npm run lint
```

`npm test` builds the extension and runs the automated suite, but it cannot
prove that the real manifest, execution worlds, and worker lifecycle work in a
browser. Run `npm run verify -- chrome` after changes to the manifest, build
configuration, worker, execution worlds, or content-script startup dependencies.
Use `npm run verify -- browsers` for coverage in both Chrome and Firefox, and
select additional checks from the [development guide](docs/development.md)
for the feature you changed.

Follow the browser-verification rules in [AGENTS.md](AGENTS.md): keep automated
checks hidden or in the background, preserve existing browser sessions, and
use isolated fixtures for repeatable tests. Keep live provider checks minimal
and avoid saving or changing real account data during verification.

Documentation-only changes usually need a review of links, examples, and
formatting rather than the full runtime suite. Report the checks you actually
ran and identify any unverified behavior or environment limitations.

Review your final diff, remove unrelated changes, and make sure it contains no
private data. Be ready to explain design choices and respond to review feedback.
Small, well-explained contributions are easier to review and maintain.
