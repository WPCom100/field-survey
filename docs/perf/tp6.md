# TP-6 — PDFKit on the 06M composite (T16 spike)

Decides whether T17 builds on `react-native-pdf` (PDFKit) + a Skia overlay, or whether T17b
(server-rendered PNG tile pyramid + zoomable image viewer) replaces it (D19, D70, K1).

**Pass criteria** (Phase 4 §4): first render < 2 s on the iPad Air · pan/zoom ≥ 50 fps · memory
< 600 MB · no `PDFTilePool` crash after 100 zoom cycles — plus the T16 DoD: page↔screen mapping
proven at three zoom levels with 40 pins and a stroke canvas.

Sheet: `fixtures/Level_06M_-_Lighting_Composite_vector.pdf` — 1 page, 4235.48 × 3604.72 pt
(≈ 59 × 50 in), CropBox at the origin, no rotation, 1.82 MB, ~153K path segments (Phase 1f).

## 1. What was built (PC side, 2026-10-10)

| Piece | Where |
|---|---|
| Spike screen | `app/src/plan/PlanSpike.tsx`, route `/spike` (link on the home screen) |
| Sheet ↔ page ↔ view maps | `app/src/plan/viewport.ts` (pure; 9 vitest tests in `plan.test.ts` incl. a rotated page) |
| Pin shapes/colours (D64) + 40 seeded dummy pins | `app/src/plan/pins.ts` |
| Viewport event from PDFKit | pnpm patch of `react-native-pdf` (D92, `patches/react-native-pdf.md`) |
| Dev build with Skia + react-native-pdf + react-native-blob-util | EAS build `d5842b4e-5d2f-40fb-b671-6780192d5709` |

PC checks: `pnpm --filter app test` 9 passed · `typecheck` clean · `lint` clean · `npx expo export
--platform ios` bundles the PDF as an asset (1,821,390 bytes) · autolinking resolves all three
native packages for iOS.

How the overlay works: PDFKit owns pan/zoom. On every scroll/zoom the patched view sends the affine
page→view (a b c d tx ty) + CropBox; the screen converts it to sheet→view and gives Skia that matrix,
so pins and strokes are declared once in sheet points. Pins are scaled by 1/zoom inside the group
to keep a constant 26 px on screen; ink keeps its sheet width and zooms with the drawing. Taps come
back from PDFKit with **its own** page point; the HUD prints our mapping next to PDFKit's and the
difference Δ in points — the mapping is "proven" when Δ ≈ 0 at every zoom.

## 2. Procedure on the iPad Air (Landry)

1. Install dev build `d5842b4e…` from the EAS link (replaces `b146b497…`; same install, data kept).
2. PC: `cd app && npx expo start --dev-client`; open Field Survey on the iPad → **TP-6 plan viewer spike →**.
   The first open downloads the 1.8 MB PDF from Metro (a % appears); **close and reopen the spike
   once** so the cached copy is measured.
3. Dev menu (shake, or ⌘D in the simulator — on the iPad use the three-finger long press) →
   **Toggle performance monitor**. It shows RAM, JS heap, Views, **UI fps** and **JS fps**.
4. Record the rows below. "First render" = the HUD's `load … ms` (document loaded) and `first
   viewport … ms` (laid out and scrollable) on the cached open, plus your stopwatch impression of
   when the drawing is fully visible.
5. Pan/zoom: pinch and pan for ~20 s at ×1, ×2–3 and ×4–8; read UI fps and JS fps from the monitor
   while moving. The PDF itself is native; the pins/ink overlay is the JS-thread part — if the
   pins visibly lag behind the drawing, note it (that is the Reanimated follow-up in D92).
6. Mapping proof: in **Pan** mode tap a pin at ×1 (Fit), ×2 and ×4; record Δ and whether `hit`
   names the pin you tapped. Tap an empty spot too (hit —). Do the same after panning to a corner.
7. Ink: **Draw** mode, draw a few strokes with the Pencil over recognisable linework; **Pan** mode,
   zoom in and out: the strokes must stay on the same lines. Record stroke count and whether
   pressure varied width (HUD `pts`).
8. Stress: **100 zoom cycles** (×1 ↔ ×4 every 0.35 s, ~70 s). Watch RAM in the monitor; record the
   peak and the value 10 s after it stops. Any crash = fail (the Xcode-less equivalent of the
   `PDFTilePool` check; a crash shows as the app returning to the home screen or the dev client).
9. Optional: `Pins` off → repeat step 5 to separate PDFKit's frame rate from the overlay's.

Metro logs (React Native DevTools, `j` in Metro) show nothing extra for the spike; the HUD is the record.

**TestFlight variant (no computer):** the same spike ships in the TestFlight build (production
profile, JS bundled, PDF in the ipa; the home screen link is still there). Steps 1–2 become
"install from TestFlight → open the app → TP-6 plan viewer spike →" (the cached-copy note no longer
applies: the PDF is local). There is no dev menu, so skip step 3: **UI fps and RAM cannot be read**
and those rows stay blank until a dev-client run. The HUD's **JS fps (min)** stands in for the
overlay's frame rate — the "min" ignores the first 3 s and never resets, so read it right after the
pan/zoom pass and again after the zoom cycles. Load/first-viewport, Δ, hit, ink and the crash check
are measured the same way. Installing TestFlight replaces the dev client on the iPad (same bundle
id); reinstall the dev build from its EAS page when back at the PC.

## 3. Results (iPad Air, fill in)

| Measure | Threshold | ×1 (fit) | ×2 | ×4 | Notes |
|---|---|---|---|---|---|
| Load (`load … ms`, cached) | < 2000 ms | | — | — | |
| First viewport (`first viewport … ms`) | < 2000 ms | | — | — | |
| Drawing fully visible (stopwatch) | < 2 s | | | | |
| UI fps while panning | ≥ 50 | | | | |
| UI fps while pinching | ≥ 50 | | | | |
| JS fps while panning (overlay) | ≥ 50 | | | | pins on |
| JS fps while panning, pins off | — | | | | |
| RAM (perf monitor) | < 600 MB | | | | |
| Tap Δ ours vs PDFKit (pt) | ≈ 0 | | | | |
| Tap hit = tapped pin | yes | | | | |
| Ink stays registered after zoom | yes | | | | strokes: |
| 100 zoom cycles | no crash | peak RAM: | after: | | |
| Viewport events during a 5 s pan | — | | | | HUD counter |

iPad model / iPadOS: ______ · dev build: `d5842b4e…` · date: ______

## 4. Decision

**Pending the iPad numbers.** When filled in:

- **Pass** (all thresholds met, Δ ≈ 0 at three zooms, no crash): T17 proceeds on this foundation;
  D92 moves to Approved. If only the overlay's JS fps misses 50 while PDFKit's UI fps holds, T17
  starts by moving the overlay matrix to a Reanimated shared value (already autolinked) — note it
  as a T17 sub-step, not a fail.
- **Fail** (crash in the zoom cycles, RAM ≥ 600 MB, or PDFKit's own UI fps < 50): add **T17b** —
  server job renders the display sheet into a PNG tile pyramid (e.g. 256-px tiles, 5 levels, R2),
  the client shows it in a zoomable image viewer with the same Skia overlay and the same sheet
  coordinates (`viewport.ts` is unchanged: the affine then comes from our own gesture state).
  The `react-native-pdf` patch and dependency are removed in T17b.
