/**
 * Icons (D266 (7)): the boards draw them as 24-unit stroke SVGs; the app has no `react-native-svg`
 * (a native module, refused for now), so the same path data is drawn with Skia, already native
 * for the pins. One component, one path string per name (`iconPaths.ts`); a new icon is a new entry there. Text
 * glyphs that already serve (▸, ⋯, ☐) stay text; back is the `chevronLeft` icon (D280).
 */

import { Canvas, Group, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { ICON_PATHS, type IconName } from './iconPaths';
import { color } from './tokens';

export { ICON_NAMES, ICON_PATHS, type IconName } from './iconPaths';

type Props = {
  name: IconName;
  /** Points; the 24-unit path scales to it. */
  size?: number;
  /** Stroke colour; `text2` by default. */
  color?: string;
  /** Stroke width in grid units (the boards use 2; 2.4 for a bold check). */
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A stroke icon at `size` points. It takes no touches (the control around it does) and reads as
 * decoration to VoiceOver: an icon-only control carries its own `accessibilityLabel`.
 */
export function Icon({ name, size = 20, color: stroke = color.text2, strokeWidth = 2, style, testID }: Props) {
  const path = useMemo(() => Skia.Path.MakeFromSVGString(ICON_PATHS[name]), [name]);
  const scale = size / 24;
  return (
    <View pointerEvents="none" style={[{ width: size, height: size }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={testID}>
      {path ? (
        <Canvas style={{ width: size, height: size }}>
          <Group transform={[{ scale }]}>
            <Path path={path} style="stroke" strokeWidth={strokeWidth} strokeCap="round" strokeJoin="round" color={stroke} />
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
}
