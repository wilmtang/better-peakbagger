# Dependabot auto-merge audit — 2026-08-02

Status: **five authorization, provenance, and merge-gate defects are fixed and
verified at their available boundary.** The hardened workflow still needs one
real npm Dependabot pull request after it reaches `main` to prove GitHub's
hosted event and auto-merge behavior. This audit started from local `main` at
`bc44694` and checked the live repository settings, PR #2, its Actions logs, the
exact pinned `dependabot/fetch-metadata` source, and current GitHub documentation
rather than accepting the maintained guide's security claims at face value.

## Reassessed findings and disposition

| ID | Finding | Disposition |
| --- | --- | --- |
| F1 | The write-capable workflow ran the workflow definition from the pull request's merge commit | Fixed in `aa5b002`: the decision now runs on `pull_request_target` from trusted `main` and never checks out or executes PR content |
| F2 | The claimed all-commit verification checked only the first commit | Fixed in `aa5b002`: the workflow independently requires exactly one verified Dependabot commit at the event head |
| F3 | An existing auto-merge request and an unbound queue command could survive or race a changed head | Fixed in `aa5b002`: every head event clears auto-merge before verification and queueing uses `--match-head-commit` |
| F4 | GitHub Actions updates could merge without any required check exercising the release workflow they changed | Fixed in `aa5b002`: only npm ecosystem updates are queued automatically; Actions updates wait for review |
| F5 | Required checks were not configured to test the eventual merge against the latest `main` | Fixed in the live `main` ruleset: `strict_required_status_checks_policy` is now `true` with the same four checks and bypass policy |

## Closure ledger

### Fixed and verified

- **F1 — trusted workflow definition:** GitHub documents that `pull_request`
  runs the workflow from the PR merge commit, while `pull_request_target` runs
  the default-branch workflow. The live PR #2 log showed the old job receiving
  `contents: write` and `pull-requests: write`, so this was a real privileged
  self-modification boundary rather than a theoretical token concern. The new
  workflow uses `pull_request_target`, is pinned by a structural test, and has
  no checkout, head fetch, artifact download, cache, or PR-code execution.
- **F2 — complete provenance:** the pinned `fetch-metadata` source calls the
  pull-request commits API but destructures only `commits[0]`. The new gate asks
  for two commits and succeeds only when the response contains one commit whose
  SHA equals the event head, whose GitHub author is `dependabot[bot]`, and whose
  signature is verified. PR #2's real commit passed; an added duplicate commit
  and a substituted maintainer author both failed closed.
- **F3 — state and head binding:** opened, reopened, and synchronize events all
  clear any prior native auto-merge request before provenance is evaluated.
  Queueing then supplies the verified event SHA through GitHub CLI's
  `--match-head-commit`, so a changed head cannot reuse the earlier decision.
- **F4 — release-workflow boundary:** the `github-actions` ecosystem is still
  grouped and cooled down, but the queue step now accepts only metadata whose
  package ecosystem is `npm`. This retains automatic `bundled-runtime`,
  `copied-runtime`, `tooling`, and npm security updates while making workflow
  implementation changes manual.
- **F5 — tested merge base:** the live `main` ruleset now requires status checks
  against the latest base. A post-update API read confirmed strict mode is
  `true`, the four check contexts are unchanged, and the repository-admin
  bypass, deletion rule, and non-fast-forward rule were preserved.

Verification evidence:

- `actionlint` passed all three workflows.
- `node --test test/project/dependabot-auto-merge.test.mjs`: **3 passed, 0
  failed**. The tests pin the trusted event, no-checkout rule, reset and
  provenance ordering, exact bot/head/signature checks, npm-only condition, and
  SHA-bound queue command.
- `npm run lint:js`: passed.
- `npm test`: **1,155 passed, 0 failed**.
- `git diff --check`: passed before the implementation commit.
- A live ruleset read after the update reported
  `strict_required_status_checks_policy: true` with the same four required
  checks and the same repository-admin bypass.
- The [post-push Test run](https://github.com/wilmtang/better-peakbagger/actions/runs/30738075561)
  passed all four hosted jobs: Node tests/lint, scale tests, hidden Chrome for
  Testing 149.0.7827.55 in new headless at the 1000×760 base and exercised
  narrow viewports, and hidden Firefox 152.0.6 at 1000×760. These packaged
  smokes do not assert a WebGL renderer; graphics were not part of this change.

### Intentionally not changed

- **npm major updates remain automatic.** This is an explicit project policy,
  not an accidental consequence of a broad condition. The same build, unit,
  scale, Chrome, and Firefox checks gate them, and the manually tagged store
  release retains its rehearsal. Those checks still cannot prove layout or live
  provider behavior, so the release rehearsal remains load-bearing.
- **Administrator bypass and direct mainline work remain allowed.** The ruleset
  has a repository-admin bypass and does not require every change to arrive by
  pull request. Dependabot holds no bypass, and this audit did not broaden its
  permissions or change the repository's ordinary integration policy.
- **`dependabot/fetch-metadata` remains in the workflow.** It still provides the
  ecosystem metadata used to separate npm from Actions, and its first-commit
  verification is useful defense in depth. The code no longer attributes an
  all-commit guarantee to it.

### Changed but not fully proven

- Live npm PRs #3 and #4 exposed a metadata-token mismatch: the pinned
  `fetch-metadata` action reported `npm_and_yarn`, while the queue condition
  expected `npm`, so GitHub skipped the queue step and still marked the job
  successful. The condition and structural regression test now pin the actual
  action output. Hosted queueing remains unproven until this correction reaches
  `main` and a new or synchronized npm Dependabot head exercises it.
- No live head was deliberately contaminated to exercise the synchronize reset;
  doing so would mutate an authentic dependency PR. The ordering and negative
  provenance cases are structurally and locally tested instead.
- The hosted extension checks were hidden and protocol-driven. They do not
  prove native focus, browser chrome, window placement, permission prompts,
  touch, accessibility, or visual polish, and packaged browser checks cannot
  execute the Dependabot auto-merge event or establish its repository
  permissions.
