import { useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';

import { pressureOf } from './pressure';

/** A touch point in the drawing view's own coordinates, with Pencil pressure 0–1. */
export type DrawPoint = { x: number; y: number; p: number };

export type DrawHandlers = {
  onStart: (p: DrawPoint) => void;
  onMove: (p: DrawPoint) => void;
  /** The finger or Pencil lifted (or the touch was cancelled). */
  onEnd: () => void;
};

/**
 * One-finger / Pencil drawing gesture (T21 markup, T24 ink). React Native's own touch events carry
 * no force on an iPad (it only reports force on 3D Touch hardware), so drawing goes through
 * react-native-gesture-handler's pan, whose `stylusData.pressure` comes straight from the
 * `UITouch` of an Apple Pencil (D116). Runs on the JS thread; a tap is a begin + end with no move.
 */
export function useDrawGesture(handlers: DrawHandlers, enabled: boolean) {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .enabled(enabled)
        .minDistance(0)
        .maxPointers(1)
        .onBegin((e) => ref.current.onStart({ x: e.x, y: e.y, p: pressureOf(e.stylusData) }))
        .onUpdate((e) => ref.current.onMove({ x: e.x, y: e.y, p: pressureOf(e.stylusData) }))
        .onFinalize(() => ref.current.onEnd()),
    [enabled],
  );
}
