# Active plans

This directory is reserved for approved work that has not shipped.

Current active plans:

- [Stop the 3D map blinking when you tilt it](3d-tilt-detail-blink.md) — steps
  1-3 shipped and measured; still open are the pan-jolt change (a feel judgement
  to make in front of the real map) and whether the drape keeps its `(4, 3)`
  level-of-detail setting now that the elevation ladder is tuned. The closure
  ledger in section 12 records what shipped, the decode-bound residual that did
  not, and two predictions the plan got wrong.

Once a plan is implemented or abandoned, move it to [archive/](../archive/) and
update the maintained architecture or focused design note with the resulting
runtime behavior. Plans are decision and execution records, never the source of
truth for shipped code.
