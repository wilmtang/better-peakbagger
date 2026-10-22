# Upstream source

- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Revision: `623a9a9037d006ea727f8213f084d02a6b6f11b5`
- Source directory: `.claude/skills/ui-ux-pro-max`
- Installed: 2026-10-22
- License: MIT; the upstream notice is retained in `LICENSE`.

Local adaptations are limited to `SKILL.md`: agent-neutral script paths, Python 3 invocation, and a Better Peakbagger integration section deferring to `AGENTS.md`. Runtime Python helpers, reference documents, and data are copied unchanged. Upstream development tests are omitted because they depend on the upstream repository's tooling and layout.

Codex and Gemini CLI discover the canonical `.agents/skills/ui-ux-pro-max` directory. Claude Code discovers it through the relative symlink at `.claude/skills/ui-ux-pro-max`. Update the canonical copy rather than creating separate agent versions. Preserve the license, provenance, local adaptations, and symlink when updating.
