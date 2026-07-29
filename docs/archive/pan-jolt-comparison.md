# Comparing the pan-end zoom jolt

Step 4 of [3d-tilt-detail-blink.md](3d-tilt-detail-blink.md) was a feel
judgement, not a correctness one. The `pan-jolt-comparison` branch existed so it
could be made in front of the real map instead of by argument. **That branch was
not safe to merge unchanged**: it carried a debug keybinding that must not ship.
These instructions were placed on `main` so they would survive the branch.

## What the jolt is

MapLibre defaults `centerClampedToGround` to true. At the end of every
interactive drag it re-derives the zoom from the terrain elevation under the
middle of the screen, so that "zoom" means a consistent height above the ground.
On flat maps this does nothing. On mountains, dragging from a valley onto a ridge
and releasing the mouse changes the zoom in one instantaneous step — measured at
−0.097 zoom levels on a 60-pixel drag against synthetic terrain, and the
arithmetic gives up to a full level at higher zoom over 600 m of relief.

Tilting does not trigger it: tilt pivots about the screen centre, so the ground
under the middle does not move and the recalculation early-returns. This is a
separate bug from the tilt blink, which is why it is a separate decision.

## The trade-off you are judging

| | Ground-following zoom ON (MapLibre default) | OFF |
| --- | --- | --- |
| End of a pan across relief | Zoom steps instantaneously | Nothing happens |
| What "zoom" means | A consistent height above the terrain | A fixed map scale |
| Panning valley → summit | The view backs off to compensate | The ground comes closer |
| Camera inside a mountain | Guarded | Guarded — `_elevateCameraIfInsideTerrain` runs either way |

There is no correct answer here. The question is which one feels like the map is
behaving, and which one feels like it is fighting you.

## How to compare

```bash
git checkout pan-jolt-comparison && npm run start:chromium
```

That builds, loads the extension into a development Chrome, and reloads it on
each successful rebuild. Then:

1. Open a Peakbagger ascent page with a mountainous GPS track and switch to 3D.
2. Drag from a valley floor onto a ridge line and release. Watch the scale bar in
   the bottom-left as you release — that is where the step shows most clearly.
3. Press **Shift+J** to flip the behaviour. The frame's notice line names the
   current state, so there is no doubt which one you are feeling.
4. Repeat the same drag. Alternate a few times; the difference is small enough
   that it is easy to talk yourself into either answer on a single try.

Worth trying both a shallow pan across a valley and a long pan that climbs a lot
of relief, since the effect scales with how much the ground under the screen
centre changes.

## Outcome

The owner chose **Off**. The integration kept one Map option and no keybinding:

- `centerClampedToGround: false` in the frame's Map options;
- no `Shift+J` handler or diagnostic notice;
- the trade-off above preserved in the completed plan's closure ledger.
