/**
 * The plan's legend (T177, the "Plan · rail, card, status buttons" board; D64): two columns in a
 * popover over the plan — "Shape is the type", every role drawn with the same Skia path the pins
 * use and the app library's shape per role (Vocabulary → Pin shapes, D214), and "Colour is the
 * status", the swatches with their glyphs plus the in-review and selected rings. Replaces the
 * swatch strip that sat under the side lists.
 */

import { ROLE, ROLE_LABEL, type Role } from '@field-survey/core';
import { Canvas, Path } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Swatch } from '../ui/Swatch';
import { color, font, ring, space } from '../ui/tokens';
import { shapeAt } from './drawPins';
import { UNSURVEYED } from './filters';
import { pinStyleFor, type PinShapeMap } from './pins';

/** The device statuses in the legend's order; null is `Unsurveyed` (D110). */
export const LEGEND_STATUSES: readonly (string | null)[] = ['Complete', 'Installed, untested', 'Issue', 'Not installed', 'No access', null];

/** The legend's rows: each role with its label, in `ROLE` order (`other` last). */
export const LEGEND_ROLES: readonly { role: Role; label: string }[] = ROLE.map((role) => ({ role, label: ROLE_LABEL[role] }));

const SHAPE_BOX = { width: 28, height: 20 };

export function Legend({ shapes }: { shapes?: PinShapeMap | null }) {
  return (
    <View style={styles.root} testID="plan.legend.card">
      <View style={styles.col}>
        <Text style={styles.head}>Shape is the type</Text>
        {LEGEND_ROLES.map((r) => (
          <View key={r.role} style={styles.item}>
            <ShapeIcon role={r.role} shapes={shapes} />
            <Text style={styles.text}>{r.label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.col}>
        <Text style={styles.head}>Colour is the status</Text>
        {LEGEND_STATUSES.map((s) => (
          <View key={s ?? 'none'} style={styles.item}>
            <Swatch {...pinStyleFor(s)} size={20} />
            <Text style={styles.text}>{s ?? UNSURVEYED}</Text>
          </View>
        ))}
        <View style={[styles.item, styles.ringFirst]}>
          <View style={[styles.ring, { borderColor: ring.review }]} />
          <Text style={styles.text}>In review</Text>
        </View>
        <View style={styles.item}>
          <View style={[styles.ring, { borderColor: ring.selected }]} />
          <Text style={styles.text}>Selected</Text>
        </View>
      </View>
    </View>
  );
}

function ShapeIcon({ role, shapes }: { role: Role; shapes?: PinShapeMap | null }) {
  const path = useMemo(() => shapeAt(role, SHAPE_BOX.width / 2, SHAPE_BOX.height / 2, 17, shapes), [role, shapes]);
  return (
    <View style={SHAPE_BOX} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Canvas style={SHAPE_BOX}>
        <Path path={path} color={color.text2} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', gap: space.xl },
  col: { flex: 1, gap: 2 },
  head: { ...font.captionBold, color: color.text2, marginBottom: space.xs },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  text: { ...font.caption, color: color.text },
  ringFirst: { marginTop: space.sm },
  ring: { width: 20, height: 20, borderRadius: 10, borderWidth: 3 },
});
