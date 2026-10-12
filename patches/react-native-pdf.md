# `react-native-pdf` patch (D92)

`patches/react-native-pdf@7.0.5.patch` is applied by pnpm on every install (`patchedDependencies` in
`pnpm-workspace.yaml`), on the PC and inside EAS Build. It touches four files and changes nothing
for Android or Windows.

**Line endings:** the package is LF, but pnpm on Windows writes the patched hunks of
`RNPDFPdfView.mm` with CRLF, so a fresh `pnpm patch` edit dir has mixed endings and
`pnpm patch-commit` writes CRs into the patch. Strip them (`.gitattributes` forces LF for
`*.patch` anyway) and run `pnpm install` so the lock's `patch_hash` is the LF file's; check with
`pnpm install --frozen-lockfile`.

## Why

The plan viewer draws pins and ink in a Skia canvas **over** the PDFKit view, in sheet coordinates
(PLAN §2.2 `device.pin`, D19/D70). Stock `react-native-pdf` reports a zoom change only when a pinch
ends (`onScaleChanged`) and never reports the scroll offset, so an overlay cannot follow panning.
It also reports taps in view points, not page points.

## What it adds (iOS only)

| File | Change |
|---|---|
| `ios/RNPDFPdf/RNPDFPdfView.mm` | KVO on the inner `UIScrollView.contentOffset` (attached after the document loads, detached on recycle/dealloc) and on `PDFViewScaleChangedNotification`; both call `emitViewport`, which sends `viewport\|a\|b\|c\|d\|tx\|ty\|cx\|cy\|cw\|ch\|page` — the affine from the current page's PDF user space to points in the Pdf view (from PDFKit's own `convertPoint:fromPage:` of three points) plus the CropBox. Identical consecutive messages are dropped. `pageSingleTap` gains `\|pageX\|pageY` from `convertPoint:toPage:`. `autoScales = NO` once the fit (`scaleFactor`/min/max) has been set explicitly, so `layoutDocumentView` after a prop update (e.g. `scale`) no longer snaps back to fit. |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T17, D101) | Native command `setNativeFocus(x, y, width, height, animated)`: sets `scaleFactor` so the rect (PDF user space of the current page) fills the view, lowering `minScaleFactor` to it when needed (the stock fit from `_fixScaleFactor` is off on the new architecture, so "fit" = focus on the CropBox), then sets the inner scroll view's `contentOffset` to centre the rect (clamped; centred when the page is smaller than the view) and emits a viewport. |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T23) | `handleLongPress:` (stock: empty) sends `pageLongPress\|page\|x\|y\|pageX\|pageY` once, when the 0.3 s long press is recognised (`UIGestureRecognizerStateBegan`) — the plan's add-here menu. PDFKit may still report a single tap when that finger lifts; the app ignores taps within 900 ms of a long press. |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T23 fix, D117) | `disableTextSelectionGestures` walks the PDFView and disables every `UILongPressGestureRecognizer` and loupe / text-selection / text-interaction recognizer (PDFKit's own long press starts a selection and beat ours) after load, on every zoom and on each long press; reports them once as `gestures|n|names`. Our long press clears any selection, and the single tap `requireGestureRecognizerToFail:` the long press. (`enableTextSelection` is not applied on iOS by the package at all.) |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T23 retest) | The long press also reports `pageLongPressMove` while the finger moves and `pageLongPressEnd` when it lifts or is cancelled (same fields), and cancels the scroll view's pan when it begins, so the spot can be adjusted without the plan scrolling. `index.js` → `onPageLongPressMove` / `onPageLongPressEnd`. |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T69, D129, D132) | Draw mode. `RNPDFInkGestureRecognizer` (a `UIGestureRecognizer` subclass on the view, off until draw mode) follows **one** touch and begins at once; it sends `ink\|start\|x\|y\|p`, `ink\|move\|x\|y\|p[\|x\|y\|p…]` (the Pencil's coalesced samples, `preciseLocationInView:`), `ink\|end`; a second finger cancels it (`ink\|cancel`) and is left to the scroll view. x, y in the view's points (the `viewport` space); p = Pencil force / max force, -1 for a finger. Native command `setNativeInkMode(enabled)` → `applyInkMode:`: enables the recognizer, sets the inner scroll view's `panGestureRecognizer.minimumNumberOfTouches` to 2 (back to 1 when off; re-applied when PDFKit swaps the scroll view and after a load), and disables our single/double tap and long press plus PDFKit's own tap recognizers while drawing (re-enabled exactly as they were). The pinch is untouched, so two fingers pan and zoom. |
| `ios/RNPDFPdf/RNPDFPdfView.mm` (T70) | After each load the view sends `patch\|t70\|ink,longpress-move`; `index.js` logs it as `[plan] pdf native patch: …`, so Metro shows which patch the installed binary carries (dev builds all read `1.0.0 (6)`). Bump the tag when the native side changes. |
| `fabric/RNPDFPdfNativeComponent.js` (T17) | `setNativeFocus` in the codegen command spec (`Double`×4 + `boolean`), so codegen generates `- (void)setNativeFocus:(double)x y:(double)y width:(double)width height:(double)height animated:(BOOL)animated`. T69: `setNativeInkMode` (`boolean`) → `- (void)setNativeInkMode:(BOOL)enabled`. |
| `index.js` | Parses the fixed-arity messages before the generic `message[4]` join and calls `onViewportChanged(viewport)` / `onPageSingleTap(page, x, y, pageX, pageY)` / (T23) `onPageLongPress(page, x, y, pageX, pageY)`; `gestures|…` is logged to the console. T17: `focusRect(x, y, width, height, animated = true)` dispatches the command (Fabric only). T69: `setInkMode(enabled)` dispatches `setNativeInkMode`; an `ink|…` message goes to `onInkMessage(raw)` unparsed (`app/src/ink/touches.ts` parses it, tested in Node). |
| `index.d.ts` | `PdfViewport` type, `onViewportChanged`, the two extra tap arguments, `onPageLongPress` (T23); `PdfRef.focusRect`; `onInkMessage`, `PdfRef.setInkMode` (T69). |

`app/src/plan/viewport.ts` turns the affine into sheet↔view maps (sheet = CropBox top-left origin,
y down) and the Skia matrix.

**The overlay depends on the emit being synchronous and on the main thread (T64, D106).**
`app/src/plan/uiViewport.ts` registers a Reanimated worklet for the native view's `onChange`;
Reanimated runs it inside `notifyOnChangeWithMessage` only when the event is emitted on the main
queue, which is what keeps the pins in PDFKit's run-loop turn. The worklet parses the raw
`viewport|…` string itself (`parseViewportMessage` in `viewport.ts`), so a change to the message
format must change `index.js` **and** `viewport.ts` (the worklet test pins the `%f` format).

## Upgrading the package

1. `pnpm patch react-native-pdf@<new>` → re-apply the four changes (the hunks are small; search for
   `field-survey patch`) → `pnpm patch-commit <dir>`; delete the old patch file and update
   `pnpm-workspace.yaml`.
2. Re-run the demo plan (`/demo-plan`, the TP-6 bench since T17): pins must sit on their drawing
   at Fit, ×2, ×4; a row tap must centre its pin; **⌖ Fit** must show the whole sheet.
3. A new dev build (`eas build --profile development --platform ios`): the change is native.

If upstream ever ships a viewport/scroll event, drop the patch and map its payload in `viewport.ts`.
