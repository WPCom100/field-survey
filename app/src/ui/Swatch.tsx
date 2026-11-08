/**
 * The status square with its glyph (D64): colour is never the only signal. Hollow for
 * `Not installed`; the glyph is dark on a light fill (No access) and white otherwise.
 */

import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { PinStyle } from '../plan/pins';
import { onFill } from './contrast';
import { color, radius } from './tokens';

export type SwatchProps = PinStyle & {
  /** Side in points; 22 by default, 20 in dense rows, up to 28 on the status buttons. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Swatch({ fill, hollow, glyph, size = 22, style, testID }: SwatchProps) {
  const glyphColor = hollow ? fill : onFill(fill, color.text, color.onPrimary);
  const fontSize = glyph.length > 1 ? Math.round(size * 0.36) : Math.round(size * 0.45);
  return (
    <View
      style={[
        styles.swatch,
        { width: size, height: size, borderColor: fill, backgroundColor: hollow ? color.surface : fill },
        style,
      ]}
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.glyph, { color: glyphColor, fontSize, lineHeight: fontSize + 2 }]} allowFontScaling={false}>
        {glyph}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  swatch: { borderRadius: radius.swatch, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontWeight: '700', textAlign: 'center' },
});
