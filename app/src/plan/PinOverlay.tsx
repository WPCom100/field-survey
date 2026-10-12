import { Canvas, Picture, Skia, matchFont, type SkPicture } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { drawInkLayer } from './drawInk';
import { drawBoundaries, drawGridMarks, type BoundaryLabel, type BoundaryLine, type GridMark } from './drawLayers';
import { drawPins, type PinFonts } from './drawPins';
import { layoutPins, type RenderPin } from './layout';
import type { Affine } from './viewport';

type Props = {
  /** sheet → view, written from every viewport event; null until the sheet is shown. */
  matrix: SharedValue<Affine | null>;
  pins: readonly RenderPin[];
  selectedId: string | null;
  showPins: boolean;
  labels: boolean;
  photos: boolean;
  width: number;
  height: number;
  /** All users' ink (T24) in sheet coordinates, drawn under the pins; null = ink layer off or empty. */
  ink: SkPicture | null;
  /** Source-sheet boundaries (T45, D100) with their labels; null = layer off or none on this sheet. */
  boundaries?: { lines: readonly BoundaryLine[]; labels: readonly BoundaryLabel[] } | null;
  /** Grid bubbles of the calibration, shown while the Grid panel is open (T45); null = hidden. */
  gridMarks?: readonly GridMark[] | null;
};

/**
 * The Skia layer over the PDF (D95): ink (T24) first, then the pins. The picture is a derived value of the viewport matrix, so
 * on pan/zoom it is re-recorded on the UI thread without a React render; React only re-creates
 * the worklet when pins, selection or layers change. The matrix is written inside PDFKit's own
 * scroll callback (`useUiViewport`, T64), so this mapper runs in the same run-loop turn. Takes no
 * touches: pinch, pan and tap belong to PDFKit underneath.
 */
export const PinOverlay = memo(function PinOverlay({ matrix, pins, selectedId, showPins, labels, photos, width, height, ink, boundaries, gridMarks }: Props) {
  const fonts = useMemo<PinFonts>(
    () => ({
      glyph: matchFont({ fontFamily: 'Helvetica', fontSize: 11, fontWeight: 'bold' }),
      label: matchFont({ fontFamily: 'Helvetica', fontSize: 11 }),
      badge: matchFont({ fontFamily: 'Helvetica', fontSize: 9, fontWeight: 'bold' }),
    }),
    [],
  );

  const picture = useDerivedValue(() => {
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, width, height));
    const m = matrix.value;
    if (m && boundaries && boundaries.lines.length > 0) {
      try {
        drawBoundaries(canvas, boundaries.lines, boundaries.labels, m, fonts.label);
      } catch (e) {
        console.error(`[plan] boundary layer failed: ${String(e)}`);
      }
    }
    if (m && ink) {
      try {
        drawInkLayer(canvas, ink, m);
      } catch (e) {
        console.error(`[plan] ink layer failed: ${String(e)}`);
      }
    }
    if (m && gridMarks && gridMarks.length > 0) {
      try {
        drawGridMarks(canvas, gridMarks, m, fonts.glyph);
      } catch (e) {
        console.error(`[plan] grid layer failed: ${String(e)}`);
      }
    }
    if (m && showPins && pins.length > 0) {
      // An exception on the UI thread ends a release build: degrade to an empty pin layer.
      try {
        drawPins(canvas, pins, layoutPins(pins, m, width, height), fonts, { labels, photos, selectedId });
      } catch (e) {
        console.error(`[plan] pin layer failed: ${String(e)}`);
      }
    }
    return recorder.finishRecordingAsPicture();
  }, [pins, selectedId, showPins, labels, photos, width, height, fonts, ink, boundaries, gridMarks]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
});
