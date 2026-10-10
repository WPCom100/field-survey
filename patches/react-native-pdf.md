# `react-native-pdf` patch (D92)

`patches/react-native-pdf@7.0.5.patch` is applied by pnpm on every install (`patchedDependencies` in
`pnpm-workspace.yaml`), on the PC and inside EAS Build. It touches three files and changes nothing
for Android or Windows.

## Why

The plan viewer draws pins and ink in a Skia canvas **over** the PDFKit view, in sheet coordinates
(PLAN §2.2 `device.pin`, D19/D70). Stock `react-native-pdf` reports a zoom change only when a pinch
ends (`onScaleChanged`) and never reports the scroll offset, so an overlay cannot follow panning.
It also reports taps in view points, not page points.

## What it adds (iOS only)

| File | Change |
|---|---|
| `ios/RNPDFPdf/RNPDFPdfView.mm` | KVO on the inner `UIScrollView.contentOffset` (attached after the document loads, detached on recycle/dealloc) and on `PDFViewScaleChangedNotification`; both call `emitViewport`, which sends `viewport\|a\|b\|c\|d\|tx\|ty\|cx\|cy\|cw\|ch\|page` — the affine from the current page's PDF user space to points in the Pdf view (from PDFKit's own `convertPoint:fromPage:` of three points) plus the CropBox. Identical consecutive messages are dropped. `pageSingleTap` gains `\|pageX\|pageY` from `convertPoint:toPage:`. |
| `index.js` | Parses the two messages before the generic `message[4]` join and calls `onViewportChanged(viewport)` / `onPageSingleTap(page, x, y, pageX, pageY)`. |
| `index.d.ts` | `PdfViewport` type, `onViewportChanged`, the two extra tap arguments. |

`app/src/plan/viewport.ts` turns the affine into sheet↔view maps (sheet = CropBox top-left origin,
y down) and the Skia matrix.

## Upgrading the package

1. `pnpm patch react-native-pdf@<new>` → re-apply the three changes (the hunks are small; search for
   `field-survey patch`) → `pnpm patch-commit <dir>`; delete the old patch file and update
   `pnpm-workspace.yaml`.
2. Re-run the TP-6 spike (`/spike` in the app): tap agreement must still read Δ ≈ 0 pt at ×1, ×2, ×4.
3. A new dev build (`eas build --profile development --platform ios`): the change is native.

If upstream ever ships a viewport/scroll event, drop the patch and map its payload in `viewport.ts`.
