# logistical-fantasy-map

A browser tool for working out the map of a fictional world iteratively. You
state the facts your setting has already established. The generator keeps
those facts and fills in everything you haven't decided with plausible
terrain: ridges, valleys, rivers that run downhill and join on their way to
the sea, coastlines and lakes.

```sh
npm install
npm run dev      # open the printed URL
npm test         # engine tests (hydrology, constraints, locking, stability)
npm run build    # static site in dist/
```

The first launch opens a small worked example, *The Wend Marches*. Your work
autosaves in the browser. **World → Save…** writes a JSON file you can keep
in version control.

## The idea: facts vs. freedom

Everything you decide is a **fact** and is kept. Everything else comes from
the **seed** and can be rerolled.

| You decide                          | How                                    | What the generator guarantees                                         |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| A mountain range runs *here*        | **Ridge** tool (draw a line)           | High ground along the line; rivers flow around it, not across it      |
| A river runs *here*                 | **River** tool (source → mouth)        | A river through every clicked point, cut downhill, land kept under it |
| This is land / sea                  | **Land** / **Sea** brushes             | Coastline follows the paint (with a natural ragged edge)              |
| This area is plains / hills / mountains | Landform brushes                   | Relief adjusted to match                                              |
| I like this bit of terrain          | **Lock** brush                         | Frozen exactly; rerolling the seed leaves it alone                    |
| A town is *exactly here*            | **Place** tool, "Exactly here"         | Terrain is reshaped so the town's site facts become true              |
| A town is *roughly here*            | "Near here" + radius                   | Solver picks a spot in the radius that satisfies its facts            |
| A town exists *somewhere*           | "+ Add floating place" / "Anywhere"    | Solver picks a spot anywhere                                          |

**Site facts** for a place: on a river, on the coast, at a river mouth, at a
confluence, on a lakeshore, on a ridge, in mountains, in hills, in a valley,
on a plain.

**Rules** between two places:
- *Distance between*: a minimum and/or maximum, in km, as the crow flies.
- *Mountains between*: the straight line between them crosses ground at least
  1000 m high and at least 300 m above both towns. On maps smaller than
  800 km both heights shrink with relief (about 250 m and 75 m on a 16 km
  locale), so it reads as a ridge between two villages.
- *On the same river*: one is downstream of the other on the same river.

Unsatisfied facts show in red, with a reason, both in the panels and on the map.

### How facts get satisfied

Generation runs in passes:

1. **Pass A** builds terrain from the seed plus your drawn and painted
   features, then places floating towns with a constraint solver.
2. Any fact still false (a fixed town that isn't on a river, two towns with
   no mountains between them…) becomes a small **implicit feature**: a river
   course along the existing drainage, a ridge across the line between the
   towns, an inlet so a port reaches the sea, and so on.
3. **Pass B** rebuilds with those features. Facts that pass A happened to
   satisfy are pinned too, so they don't drift. A third pass catches
   anything the second one disturbed.

Implicit features show as dotted lines. **Terrain → What the generator did**
lists them along with any warnings, such as "River X crosses ridge Y; carved
a gorge".

Floating towns remember where they landed last time. Editing something
unrelated doesn't shuffle them. **World → Reshuffle floating places** lets
them move.

### Realism rules the engine enforces

- Every land cell drains to the sea or off the map edge. Depressions are
  either filled (dry basin floors) or become lakes with an outlet
  (priority-flood with an epsilon gradient).
- Rivers only flow downhill and only merge, never split, so they cannot
  cross a drainage divide. If you *draw* a river across a ridge, it cuts a
  gorge (a water gap) and you get a warning.
- Valleys are carved by stream-power erosion: bigger rivers cut deeper.
- **Landforms** are classified from local relief and from whether the ground
  rises on *both* sides (valley) or only one (a plain at a mountain front).
  Turn on **View → Landform colours** to see them. Hover any point for
  elevation, landform, river catchment and distance to the sea.

## Using it

- **Navigate**: scroll to zoom, drag with the Select tool (or right/middle
  drag with any tool) to pan, **Fit** to reset.
- **Draw** ridges and rivers: click points, then double-click, right-click
  or press Enter to finish. Backspace removes the last point and Esc
  cancels. Select a feature to drag its handles or edit its height and width.
- **Brushes**: `[` and `]` change the size.
- **Shortcuts**: V select, P place, R ridge, W river, M measure, Delete
  removes the selection, Ctrl+Z / Ctrl+Shift+Z undo and redo.
- **Suggested settlements** (World → Settlements) fills empty country with
  towns at good sites (confluences, river mouths, coasts). Click **Keep** to
  adopt one as a fact.
- **Export PNG** renders the whole map at 2400 px wide.

## Map scale

**World → Map size** sets the map from 5 km across up to continent size,
with presets for a *Locale* (16 × 16 km), *Region*, *Realm* and *Continent*.
Terrain is tuned for maps of 800 km and up. On smaller maps the natural
feature sizes (valley spacing, ridge widths, coastline wiggle, implicit
features) and local relief shrink, and the river threshold shrinks with the
map's area. A locale gets creeks and spurs rather than a miniature
continent. Brush sizes, new ridges and the km sliders scale with the map too.

You can zoom from the whole map down to a few hundred metres across. Once a
terrain cell covers more than a couple of screen pixels, the view switches
to **detail tiles**, rendered in web workers. They add relief below the
engine's grid, plus ragged coastlines and lake shores. Contours are
re-derived at an interval that suits the zoom. The detail is a deterministic
function of position: it stays faithful to the engine at cell scale and
looks the same every time you return. Rivers gain bends as you zoom and,
up close, are drawn at a plausible true width. Mountain and hill symbols
stay the same size on screen. Zooming in only adds symbols between the
existing ones, and their density stops at the terrain's real resolution.
From there, shading, contours and spot heights describe the ground. The
scale bar shows kilometres and miles.

## Code layout

```
src/engine/        pure TypeScript, no DOM; runs in a Web Worker
  types.ts         WorldDoc (your facts) and WorldResult (derived map)
  generate.ts      the pass A / pass B pipeline
  terrain.ts       base terrain, ridges, paint, locking, river carving
  hydrology.ts     depression filling, flow routing, erosion, rivers, lakes
  analysis.ts      landforms, ridge lines, per-cell site masks
  placement.ts     min-conflicts solver for places; rule evaluation
  shaping.ts       turns unmet facts into implicit terrain features
  doc.ts           defaults and JSON (de)serialisation
src/ui/            React app, canvas renderer
  render.ts        scene, terrain drawing, rivers, labels
  detail.ts        sub-cell terrain model and tile rendering (no DOM)
  tiles.ts         tile cache and worker pool; tileWorker.ts runs renderTile
  glyphs.ts        screen-sized mountain/hill symbols on a quadtree lattice
tests/             vitest suite for the engine and the detail renderer
scripts/           dev aids: preview.ts (render a PNG in Node), shot.mjs (browser screenshot)
```

## Known limits

- Distances are straight-line, not travel distance along roads or rivers.
- "On a lakeshore" can be found by the solver but isn't created by reshaping.
- Facts can genuinely contradict each other, e.g. a town required to be on a
  plain that sits right next to a range you asked for. The tool reports
  these rather than hiding them.
