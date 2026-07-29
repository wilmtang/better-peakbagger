# Comparing the pan-end zoom jolt

Step 4 of [3d-tilt-detail-blink.md](3d-tilt-detail-blink.md) was a feel
judgement, not a correctness one, and it was made in front of the real map
rather than by argument. **The answer was "no perceptible difference" and
nothing shipped** — see [Outcome](#outcome). The rest of this note is kept
because the trade-off and the way it was driven are the parts worth having if
the question is ever reopened.

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

The `pan-jolt-comparison` branch that carried this originally has been merged and
its toggle removed, so reopening the question means re-adding a temporary
keydown handler in `src/terrain/terrain-frame.js` — next to the `Escape`
handler, calling `map.setCenterClampedToGround(...)` and naming the state
through `showNotice`. Keep it uncommitted; it must not ship. Then:

```bash
npm run start:chromium
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

**Nothing shipped. MapLibre's default stands.**

An earlier revision of this section claimed the owner had chosen **Off**. That
was written when `centerClampedToGround: false` was merged into `main` ahead of
the judgement, and it recorded a decision nobody had made.

The comparison was then actually run, in the live map, with the toggle flipping
between the two behaviours in one session. The verdict was that there was not
much difference between them.

That is a real answer, and it resolves to the default: a deviation from a
library's documented behaviour has to earn its keep in perceptible benefit,
because it is behaviour we then own, document, and re-verify on every MapLibre
upgrade. An effect the only person to judge it could barely feel does not clear
that bar. So `centerClampedToGround: false` and the `Shift+J` toggle were both
removed.

This does not retract the measurement. The jolt is real — −0.097 zoom levels on
a 60-pixel drag against synthetic terrain, and arithmetically up to a full level
at higher zoom over 600 m of relief. If it ever becomes a complaint, the finding
above is still valid and the option is one line; the reason it is not there is
that it was judged, not that it was overlooked.
