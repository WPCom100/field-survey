import { useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { isDoubleTap, MAX_ZOOM, MIN_ZOOM, tapZoomRect, type Tap } from './model';

/**
 * An image that pinches, pans and double-taps to zoom (T129): an enlarged source crop. The red
 * outline is drawn into the PNG by the server, so it follows the picture. UIKit's own scroll-view
 * zoom does the pinch and the pan (T135: gesture-handler's pinch never activated inside the
 * `Modal`); the double tap is timed in JS and zooms through `scrollResponderZoomTo`.
 */
export function ZoomableImage({ uri, accessibilityLabel }: { uri: string; accessibilityLabel?: string }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scroll = useRef<ScrollView>(null);
  const scale = useRef(MIN_ZOOM);
  const lastTap = useRef<Tap | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scale.current = e.nativeEvent.zoomScale ?? scale.current;
  };

  // locationX / Y are in the image's own (unzoomed) points, which is what zoomToRect takes.
  const onPress = (e: GestureResponderEvent) => {
    const tap = { t: Date.now(), x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    if (!isDoubleTap(lastTap.current, tap, scale.current)) {
      lastTap.current = tap;
      return;
    }
    lastTap.current = null;
    scroll.current?.scrollResponderZoomTo({ ...tapZoomRect(scale.current, tap, size), animated: true });
  };

  return (
    <View style={styles.frame} onLayout={onLayout}>
      {size.width > 0 ? (
        <ScrollView
          ref={scroll}
          style={styles.frame}
          contentContainerStyle={{ width: size.width, height: size.height }}
          minimumZoomScale={MIN_ZOOM}
          maximumZoomScale={MAX_ZOOM}
          centerContent
          bouncesZoom
          alwaysBounceHorizontal={false}
          alwaysBounceVertical={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
        >
          <Pressable onPress={onPress} accessibilityHint="Double-tap to zoom in or back to fit">
            <Image source={{ uri }} style={{ width: size.width, height: size.height }} resizeMode="contain" accessibilityLabel={accessibilityLabel} />
          </Pressable>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: '#f3f5f8' },
});
