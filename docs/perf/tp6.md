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

## 3. Results (iPad Air, TestFlight 1.0.0 (4), Landry, 2026-10-10)

Two TestFlight runs. Build 3 loaded in 169 ms and drew in 1–2 s but had no pinch/pan, no taps and
an inert `scale` prop (`singlePage` had switched PDFKit's user interaction off; `autoScales`
snapped the zoom back) — fixed in build 4 (`3653092`). Build 4 numbers, from the HUD photo and
Landry's report ("all functional; pins and pen are accurate, with jitter while zooming"):

| Measure | Threshold | Result | Notes |
|---|---|---|---|
| First viewport (`first viewport … ms`) | < 2000 ms | **169 ms** | laid out and scrollable |
| Drawing fully visible | < 2 s | **1–2 s** (both runs) | |
| Load (`load … ms`) | < 2000 ms | 169 ms (build 3); HUD showed 210,496 ms in build 4 | `loadComplete` is re-posted by PDFKit later and overwrote the first value; HUD now keeps the first (`3653092`+) |
| JS fps while panning/zooming, pins on | ≥ 50 | **119 (min 106)** | after ~7,000 viewport events, 2 strokes, 100 cycles |
| JS fps, pins off | — | not taken | |
| UI fps (PDFKit) | ≥ 50 | **not measurable on TestFlight** | pinch/pan reported smooth; overlay jitters one event behind |
| RAM | < 600 MB | **not measurable on TestFlight** | → first check of the T17 dev-client session |
| Tap Δ ours vs PDFKit | ≈ 0 | **0.00 pt** at ×0.93 — ours (1060.0, 624.6) = PDFKit (1060.0, 624.6); 23 taps | accurate at every zoom per Landry |
| Tap hit = tapped pin | yes | crosshair lands where tapped; hit `—` on the photographed empty tap | |
| Ink stays registered after zoom | yes | **yes** (2 strokes, 55 pts) | jitter during the pinch, locked when still |
| 100 zoom cycles | no crash | **100/100, app alive** | |
| Viewport events | — | 6,892 over the session | |

Oddities for T17: at **Fit** PDFKit sits at ×0.93 (page reported 3920×3336 at `loadComplete`,
i.e. the sheet is ≈ 3.3 screens wide), so `react-native-pdf`'s fit-both does not compute from the
real frame on the new architecture — harmless here because the overlay reads the true transform, but
T17 must set its own fit. The overlay **jitters during a pinch**: it is redrawn on the JS thread one
viewport event behind PDFKit's native zoom (expected from the architecture, D92).

iPad: Landry's iPad Air (UDID …801C), iPadOS 17+ · TestFlight build 4 (`214ccaa2…`) · 2026-10-10

## 4. Decision (2026-10-10)

**Pass — T17 proceeds on `react-native-pdf` (PDFKit) + the Skia overlay; T17b is not added.**

Grounds: first render 169 ms / drawn in 1–2 s (threshold 2 s); 100 zoom cycles without a crash on
the 153K-segment composite (the K1 risk); page↔screen mapping exact (Δ 0.00 pt, ours = PDFKit) and
reported accurate at every zoom; overlay JS thread at 106–119 fps; ink registered after zoom.

Caveats carried into T17 (recorded as follow-ups in `TASKS.md`):
1. **RAM** and PDFKit's **UI fps** could not be read on TestFlight. T17's first on-device step is a
   Perf Monitor run on a rebuilt dev client (the current dev build predates the build-4 fix). If RAM
   ≥ 600 MB at ×4 after the cycles, this decision is reopened and T17b is added then.
2. **Pinch jitter**: the overlay lags one viewport event behind PDFKit. T17 moves the sheet→view
   matrix to a Reanimated shared value updated from the native event (UI thread), or, if that is
   still a frame behind, hides the overlay during an active pinch and re-shows it on end — a
   D-number before Reanimated becomes a direct dependency.
3. **Fit**: T17 computes its own fit scale from the viewport (page size vs. view size) instead of
   relying on `fitPolicy`.
4. `loadComplete` fires more than once; use the first viewport as the "ready" signal.

D92 (dependencies, patch, sheet coordinates) stands and should move to Approved with this decision.

## 5. T17 follow-up run (dev client) — to do on the iPad

T17 removed the spike (`/spike`, `PlanSpike.tsx`). The bench is now the **demo level**: home screen →
**Demo plan (06M composite) →** (route `/demo-plan`), the same sheet with ~48 seeded devices in a
separate local database that never syncs. It needs the dev build made at the end of T17 (the patch
gained the `setNativeFocus` command, D101); see `TASKS.md` T17 for the build id.

1. Install the T17 dev build, `cd app && npx expo start --dev-client`, open the demo plan (first open
   downloads the PDF from Metro; close and reopen it once).
2. Dev menu → **Toggle performance monitor**. Record RAM at Fit, at ×4 (pinch in on the electrical
   room cluster), and 10 s after **TP-6: 100 zoom cycles** (bottom-right of the plan, dev only; Fit ↔
   ×4 every 0.35 s). RAM ≥ 600 MB reopens §4 (T17b).
3. UI fps and JS fps while pinching and panning for ~20 s with pins on.
4. **Pinch jitter (D95):** do the pins stay glued to the drawing during a pinch, not only when the
   fingers stop? The overlay now draws on the UI thread from a shared value (no React render per
   event). Note "glued" / "still trails". If it still trails, the next step is native (D95).
5. Fit: **⌖ Fit** shows the whole sheet centred (not ×0.93 of a 3.3-screens-wide page).

| Measure | Threshold | Result |
|---|---|---|
| RAM at Fit | < 600 MB | **479 MB** |
| RAM at ×4 | < 600 MB | **530 MB** |
| RAM 10 s after 100 cycles | < 600 MB | **512 MB**; no crash. Transient **peak 620 MB** near cycle 90 |
| UI fps pinching (pins on) | ≥ 50 | **60** |
| JS fps pinching | — | **60** |
| Pins glued during pinch | yes | **no — trails**, settles exactly when the fingers stop |
| Fit shows the whole sheet | yes | **yes** (opens at fit; ⌖ Fit centres) |

Run: Landry's iPad Air, dev build `a5f5c323` with JS from Metro (debug bundle, so RAM is higher than a release build would be), 2026-10-10, after the D102 driver fix. Also confirmed: pins on their drawing at Fit/×2/×4 when still, D64 shapes/colours/glyphs, "+" and camera marks, clusters at fit and cluster tap zooms in, pin ↔ row highlight both ways, filters (Status, Owner incl. the EC/ETC rule, Open punch = 16) and layers, prefs kept per level.

**Reading against §4:** the TP-6 rule (RAM ≥ 600 MB at ×4 after the cycles reopens the decision) is **not** triggered: 512 MB after the cycles, 530 MB at ×4. The 620 MB transient peak during the stress cycles is a watch item: re-measure on a release (TestFlight) build when a Perf Monitor reading is possible, and on a real level sheet when T45 delivers one. UI-thread drawing (D95 step 1) did **not** remove the pinch trail; D95's native step is task T64.

## 6. T64 run (dev client) — to do on the iPad

T64 (D106) moves the viewport handling onto the UI thread: the patch's KVO emit runs a Reanimated
worklet that writes the overlay matrix, and the pin picture is redrawn before PDFKit's frame is
committed (no JS-thread hop, no wait for the next frame). JS only, so the **T17 dev build
`a5f5c323`** runs it over Metro; no new build.

1. Pull `main`, `cd app && npx expo start --dev-client`, open **Demo plan (06M composite)**. Metro's
   log shows `[plan] viewport handled on the UI thread (view N)`. Without that line the old path is
   still drawing, so stop and report it.
2. **Pinch** slowly and quickly over the electrical room cluster and over a lone pin, both ways:
   do the pins stay on their drawing **while** the fingers move? Pins keep their size throughout.
3. **Pan** fast with one finger, and fling: same question.
4. Regression: Fit, a row tap (pin centred), a pin tap (row highlighted), clusters split at ×2.
5. UI fps while pinching with pins on (Perf Monitor), against T17's 60.

| Check | Expected | Result |
|---|---|---|
| UI-thread log line | present | |
| Pins glued during pinch | yes | |
| Pins glued during pan / fling | yes | |
| Pin size constant during pinch | yes | |
| Fit, row tap, pin tap, clusters | unchanged | |
| UI fps pinching (pins on) | ≥ 50 | |

"Still trails" → the native step in D106 (layer transform from the KVO turn; new dev build).
