import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { doubleTapZoom, panZoom, pinchZoom, type Zoom } from './model';

/**
 * An image that pinches, pans and double-taps to zoom (T129): an enlarged source crop. The red
 * outline is drawn into the PNG by the server, so it follows the picture. Gesture-handler +
 * Reanimated on the UI thread (both already in the build); the caller supplies the
 * `GestureHandlerRootView` (a `Modal` needs its own).
 */
export function ZoomableImage({ uri, accessibilityLabel }: { uri: string; accessibilityLabel?: string }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const view = useSharedValue({ width: 0, height: 0 });
  const zoom = useSharedValue<Zoom>({ scale: 1, x: 0, y: 0 });
  const start = useSharedValue<Zoom>({ scale: 1, x: 0, y: 0 });
  const focal = useSharedValue({ x: 0, y: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
    view.value = { width, height };
  };

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        start.value = zoom.value;
        focal.value = { x: e.focalX, y: e.focalY };
      })
      .onUpdate((e) => {
        zoom.value = pinchZoom(start.value, e.scale, focal.value, { x: e.focalX - focal.value.x, y: e.focalY - focal.value.y }, view.value);
      });
    const pan = Gesture.Pan()
      .maxPointers(1)
      .onStart(() => {
        start.value = zoom.value;
      })
      .onUpdate((e) => {
        zoom.value = panZoom(start.value, e.translationX, e.translationY, view.value);
      });
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd((e) => {
        zoom.value = doubleTapZoom(zoom.value, { x: e.x, y: e.y }, view.value);
      });
    return Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, pan));
  }, [focal, start, view, zoom]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: zoom.value.x }, { translateY: zoom.value.y }, { scale: zoom.value.scale }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.frame} onLayout={onLayout} collapsable={false}>
        {size.width > 0 ? (
          <Animated.Image source={{ uri }} style={[{ width: size.width, height: size.height }, style]} resizeMode="contain" accessibilityLabel={accessibilityLabel} />
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden', backgroundColor: '#f3f5f8' },
});
