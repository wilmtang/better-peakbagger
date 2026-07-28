# Active plans

This directory is reserved for approved work that has not shipped.

Current active plans:

- [ImgBB-backed topo photo editor and photo library](imgbb-photo-editor.md) —
  local non-destructive topo editing, bring-your-own-key upload, an
  extension-owned photo catalog, and optional GitHub metadata recovery.
- [Stop the 3D map blinking when you tilt it](3d-tilt-detail-blink.md) — steps
  1-3 shipped and measured, and the drape's `(4, 3)` level-of-detail setting
  measured and kept. Still open is only the pan-jolt change, a feel judgement to
  make in front of the real map; see
  [pan-jolt-comparison.md](pan-jolt-comparison.md). The closure ledger in section
  12 records what shipped, the decode-bound residual that did not, and three
  predictions the plan got wrong.

Once a plan is implemented or abandoned, move it to [archive/](../archive/) and
update the maintained architecture or focused design note with the resulting
runtime behavior. Plans are decision and execution records, never the source of
truth for shipped code.
