/**
 * A form's or dialog's buttons (D280 (5), `docs/nav-plan.md` §2.3, T191): at the bottom right,
 * Cancel on the left of the primary. The caller passes them in that order; the row only aligns
 * them to the right and wraps on a narrow panel.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from './tokens';

export function FormActions({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm },
});
