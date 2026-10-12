# Grid calibration and Drawing Position (`src/grid.ts`, T45)

The client side of PLAN §7.4 / D47 / D147. The server's plans job (`server/docs/plans.md`) writes
`sheet.grid_sets` and `sheet.features`; this module reads them, words a pin's Drawing Position,
and builds a set by hand from three taps. Pure TypeScript: Node tests in `grid.test.ts` run the
same cases as the server's `test_plans.py` over `testing/grid-06m.json` (the three sets the text
pass found on the 06M composite).

| Function | What it does |
|---|---|
| `parseGridSets(raw)` / `parseSheetFeatures(raw)` | Defensive readers of the stored JSON (a column value or its text); malformed entries are dropped, never thrown |
| `frameOf(set, p)` | Sheet point → `(s, t)`: `s` across the column lines (east positive), `t` across the row lines (south positive) |
| `chooseGridSet(sets, p)` | The set whose grid (+1.5 spacings) holds the point; deepest wins where two overlap; else the nearest within two more spacings; else null. Sets in mode `none` never claim a point |
| `drawingPosition(sets, p)` | `Grid B-C / 9-8`, `Grid E / 7.5` (within 8 % of the spacing of a line), `Grid East of H / 9-8`, `Grid B-C / North of 13.5`, `WT Grid C.-D. / 6.-5.` (the set's prefix, labels verbatim); null when no set claims the point |
| `gridSummary(sets)` | The Sources table line: `auto ✓ 3 sets`, `manual ✓ 1 set`, `needs calibration (residual 4.1 pt)`, `no grid found` |
| `nearestRoom(features, p, maxDist)` / `roomText(room)` | The room code printed nearest the point and the master's wording `Stair A Vestibule XX06M-2SV01` |
| `labelKind` / `labelKey` / `labelSequence` | `alpha` or `num`; the natural order (`A`=1 … `Z`=26, `AA`=27, `G.9`=7.9); the consecutive labels between two (`C.`…`F.` keeps the dotted style) |
| `manualGridSet(taps, {name, prefix})` | The three-tap fallback: two bubbles of one axis fix its direction, spacing and labels, one of the other fixes its origin (spacing taken from the first axis, or from a fourth tap); orthogonal, evenly spaced, mode `manual`. Throws a plain-language error on taps that cannot make a grid |
| `snapLabel(sets, features, p)` | The printed label within 30 pt of a tap (the sets' bubbles and the loose ones) — what the label prompt pre-fills |

Where it is used: `app/src/plan/PlanScreen.tsx` (⌗ Grid panel: test taps, calibration taps,
saving `sheet.grid_sets` as one `Master edit` op; Drawing Position and Room defaults on + Device;
Drawing Position following a moved pin unless typed by hand), `app/src/plan/drawLayers.ts`
(boundaries and grid marks on the overlay), `app/src/setup/sheets.ts` (the Floor plans table).
