import { matchFont } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CartesianChart, StackedBar } from 'victory-native';

import { pinStyleFor } from '../plan/pins';
import { chartData, type SummaryTable } from './model';

/**
 * Bar colours per status. Device statuses use the pin colours (D64), with `Not installed` a light
 * red so it stands apart from `Issue` in a stack (pins tell them apart by the hollow shape). The
 * legend and the table beside the chart carry the numbers, so colour is never the only signal.
 */
const COLOR: Record<string, string> = {
  'Not installed': '#ef9a9a',
  Open: '#c62828',
  'In progress': '#f9a825',
  Closed: '#2e7d32',
  Needed: '#c62828',
  Ordered: '#f9a825',
  'On site': '#1565c0',
  Installed: '#2e7d32',
};
export const statusColor = (s: string) => COLOR[s] ?? pinStyleFor(s).fill;

const font = matchFont({ fontFamily: 'Helvetica', fontSize: 11 });

/** One stacked bar per floor (or owner) of a Summary table (T38, victory-native over Skia). */
export function StackedBars({ table }: { table: SummaryTable }) {
  const data = useMemo(() => chartData(table), [table]);
  const keys = table.statuses as string[];
  const colors = useMemo(() => keys.map(statusColor), [keys]);
  if (!table.keys.length) return null;
  return (
    <View style={styles.box}>
      <View style={styles.chart}>
        <CartesianChart
          data={data}
          xKey="i"
          yKeys={keys}
          domain={{ y: [0, Math.max(1, ...table.rowTotals)] }}
          domainPadding={{ left: 24, right: 24, top: 8 }}
          xAxis={{ font, tickCount: table.keys.length, tickValues: table.keys.map((_, i) => i), formatXLabel: (i) => table.keys[Number(i)] ?? '', labelColor: '#555', lineColor: '#eef0f3' }}
          yAxis={[{ font, tickCount: 4, formatYLabel: (v) => String(Math.round(Number(v))), labelColor: '#555', lineColor: '#eef0f3' }]}>
          {({ points, chartBounds }) => <StackedBar points={keys.map((k) => points[k]!)} chartBounds={chartBounds} colors={colors} innerPadding={0.35} />}
        </CartesianChart>
      </View>
      <View style={styles.legend}>
        {keys.map((k) => (
          <View key={k} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: statusColor(k) }]} />
            <Text style={styles.legendText}>{k}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, minWidth: 260 },
  chart: { height: 190 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 12, color: '#444' },
});
