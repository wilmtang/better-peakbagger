# Repository agent instructions

Act like a skeptical senior engineer. Inspect relevant code before editing, identify root causes and broken invariants, and prefer the smallest safe change. Add regression tests when practical, state exactly what was verified, and do not perform unrelated refactors.

When making code changes, commit each completed independent unit of work before starting another. Keep every commit focused and do not bundle unrelated changes. Run checks appropriate to the change before committing; do not commit knowingly broken or incomplete work merely to satisfy this rule. Preserve unrelated user-owned working-tree changes unless the user explicitly asks to include them.

## UX bar — design like a senior Apple designer

Hold every user-facing change to the clarity, restraint, and finish a senior Apple product designer would expect. Optimize for the user's outcome, not for exposing implementation machinery, and never trap or surprise the user.

- **Clarity first.** Give each surface one obvious primary action. Use plain language, explain confidence and failure states in terms users can act on, and move technical detail to the README instead of crowding the popup.
- **Restraint.** Prefer a sensible default over another setting, control, banner, or line of copy. Reuse the extension's existing components and visual language; Strong and Probable states must stay consistent everywhere.
- **Reversible and safe.** Make consequential actions explicit, keep temporary feedback dismissible, preserve manual review before Save, and never transmit or retain activity data beyond the consent and privacy boundaries documented by the product.
- **Native browser feel.** Use familiar browser and platform affordances, keyboard navigation, meaningful focus states, accessible names, sufficient contrast, and layouts that work in both Chrome and Firefox, light and dark contexts.
- **Show, don't tell.** Prefer a concise visual cue, progress state, or actionable error over explanatory prose. Motion should be brief, purposeful, and respect reduced-motion preferences.

For UI changes, add focused behavior tests when practical and visually inspect the real rendered result at relevant popup/page sizes before calling the work complete. A passing DOM test alone does not establish that the UX is polished.
