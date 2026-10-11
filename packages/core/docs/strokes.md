# Stroke lists: photo markup and plan ink (T21, T24)

One JSON format for both drawings the app keeps (PLAN §2.2): `photo.markup_blob` (markup over a
photo, T21) and `ink_layer.drawing_blob` (a user's ink on a plan sheet, D53, T24). Code:
`src/strokes.ts` (types, `makeStroke`, `serializeStrokeList`, `parseStrokeList`, `strokeAt`);
the app draws it with `app/src/ink/render.ts` and `app/src/ink/geometry.ts`; the server reads the
same JSON to flatten markup onto the Photo Log thumbnails (T29) and every user's ink onto the floor
PDF (T59).

A list is a **blob**: content-addressed by the SHA-256 of its bytes, never edited in place. Every
save writes a new list (new SHA) and points the record at it (`photo.markup_blob`, or
`ink_layer.drawing_blob` + `updated_at`). The original photo JPEG is never changed.

## Envelope

```json
{"format":"field-survey/strokes","version":1,"space":"image","width":4032,"height":3024,"strokes":[…]}
```

| Key | Meaning |
|---|---|
| `format` | Always `field-survey/strokes`. Anything else is refused. |
| `version` | `1`. A reader refuses a version it does not know (a newer app wrote it). |
| `space` | `image`: photo markup, units = pixels of the stored JPEG, origin top-left, y down. `sheet`: plan ink, units = PDF points of the sheet, origin = CropBox top-left, y down (D92, `app/src/plan/viewport.ts`) — the same space as `device.pin`. |
| `width`, `height` | The drawing surface in those units (the JPEG's pixel size, or the sheet's CropBox). A renderer showing the image at another size scales by `shown / width`. |
| `strokes` | In drawing order; later strokes draw on top. |

## Stroke

```json
{"id":"0192…","tool":"pen","color":"#e53935","width":16,"points":[812.4,903.1,0.42,815,907.5,0.5],"at":"2026-10-10T14:05:11.020Z"}
```

| Key | Meaning |
|---|---|
| `id` | UUID v7, unique in the list (the eraser removes by id). |
| `tool` | `pen` · `highlighter` · `arrow` · `ellipse` · `text` · `marker` (below). |
| `color` | `#rrggbb` (`#rrggbbaa` accepted). Palette in the app: red `#e53935`, yellow `#fdd835`, blue `#1e88e5`, green `#43a047`, black `#111111`, white `#ffffff`. |
| `width` | Base line width in the list's units; for `text` the font size; for `marker` the mark's size. |
| `points` | Flat triples `x, y, p`: position (rounded to 0.1 unit) and Pencil pressure `p` 0–1 (0.01). A finger has no force and records `0.5`. |
| `text` | `text` only: the words. |
| `ref` | `marker` only: `{"kind":"photo","id":"<photo id>"}`. |
| `at` | When the stroke was drawn (ISO 8601). |

### How each tool is drawn

| Tool | Points | Drawing |
|---|---|---|
| `pen` | ≥ 1 | Round-capped segments between consecutive points; segment width = `width × (0.4 + 1.2 × p̄)` with p̄ the mean pressure of its two ends (1× at the finger default). One point = a dot. |
| `highlighter` | ≥ 1 | One round-joined polyline of constant `width`, alpha 0.35. |
| `arrow` | 2 | Line start → end; head at the end: two barbs of length `4 × width` at ±π/7. |
| `ellipse` | 2 | The ellipse filling the box with those opposite corners, stroked at `width`. |
| `text` | 1 | Bold Helvetica at size `width`, baseline-left at the point, with a contrasting halo (`width / 6`). |
| `marker` | 1 | A camera mark `width` across, centred on the point, in `color` (T23 "Photo here"). |

Freehand points closer than one screen point are dropped while drawing; the end point is kept.
A reader drops a malformed stroke (counted in `skipped`) rather than refusing the whole list.

## Serialisation

`serializeStrokeList` writes keys in the order above with no whitespace, so an unchanged list
produces the same bytes and the same SHA-256 (no second upload). Expected sizes: a photo markup of a
few strokes is 1–5 KB; a busy sheet layer a few hundred KB.

## Plan ink layers (T24, D53)

| Rule | |
|---|---|
| One layer per (sheet, user) | `ink_layer` {`sheet_id`, `user_id`, `drawing_blob`, `updated_at`}; `space: sheet`, `width`/`height` = the display sheet's CropBox. The owner writes it; the app draws every other user's layer read-only (alpha 0.8) under the pins, gated by Layers ▸ Ink. |
| Saving | Debounced 1.5 s after the last change, and at once on Done / leaving the plan: serialise → new blob (new SHA-256, `kind: ink`) queued for upload → the first save `create`s the layer, later ones `set` `drawing_blob` + `updated_at` as one group (`Field survey` / "Plan ink"). Old blobs are never edited. |
| Never conflicts | The server applies `ink_layer` last-write-wins (PLAN §3.3) and the client never marks an ink op "will be reviewed". If one person's two iPads both create a layer for a sheet offline, both rows are kept and drawn; the newest is the one that person edits. |
| Sizes | Line widths are picked on screen (thin 1.5 / medium 3 / thick 6 view points; highlighter 4×) and stored in sheet points at the zoom the stroke starts at, so ink keeps its size relative to the drawing. A text note is 14 view points; a "Photo here" camera mark is 26 view points (T23, `marker` with the photo's id). |
| Editing | Undo removes the user's last stroke; the eraser removes the user's stroke under the finger (within 14 view points). Nobody erases another user's ink. |
| Download | Layers of assigned levels are prefetched with the sheets (`BlobQueue.prefetch`); a missing one is fetched on demand when the plan opens, and the draw bar says how many are not downloaded yet. |
