/**
 * Grid calibration panel (T45, Phase 3 §3.2 "Grid calibration sheet"), in the plan's side panel:
 * the sheet's grid sets (name and Drawing Position prefix editable, D47; mode and residual),
 * "Test: tap a point" (the plan shows what Drawing Position a tap reads as), and the manual
 * fallback — tap three bubbles on the plan, say which label each is (pre-filled from the printed
 * label under the tap), Finish → a `manual` set. Once two taps fix an axis the plan rings, dashed,
 * the bubbles the set would claim (T96), so a wrong tap or label shows before Finish. The plan screen owns the taps (they come from
 * the PDF view) and saves `sheet.grid_sets` as one op; this component is the form.
 */

import { labelKind, type GridSet, type GridTap } from '@field-survey/core';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { GRID_SET_COLORS } from './drawLayers';

export type GridPanelMode = 'idle' | 'test' | 'calibrate';

export type GridPanelProps = {
  levelCode: string;
  sets: readonly GridSet[];
  canEdit: boolean;
  mode: GridPanelMode;
  /** What the last test tap read as (null = tapped off every grid). */
  testResult: { text: string | null } | null;
  taps: readonly GridTap[];
  /** A calibration tap waiting for its label; `suggestion` is the printed label under it. */
  pending: { x: number; y: number; suggestion: string | null } | null;
  error: string | null;
  onTest: () => void;
  onStartCalibrate: () => void;
  onCancelCalibrate: () => void;
  onLabelPending: (label: string) => void;
  onDropPending: () => void;
  onUndoTap: () => void;
  onFinishCalibrate: (name: string, prefix: string) => void;
  onRename: (index: number, name: string, prefix: string) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
};

export function GridPanel(props: GridPanelProps) {
  const { sets, mode, taps, pending } = props;
  const [newName, setNewName] = useState('');
  const [newPrefix, setNewPrefix] = useState('');
  const [label, setLabel] = useState('');
  const pendingKey = pending ? `${pending.x},${pending.y}` : '';
  const [labelFor, setLabelFor] = useState('');
  if (pendingKey !== labelFor) {
    setLabelFor(pendingKey);
    setLabel(pending?.suggestion ?? '');
  }
  const alpha = taps.filter((t) => labelKind(t.label) === 'alpha').length;
  const nums = taps.filter((t) => labelKind(t.label) === 'num').length;
  const canFinish = taps.length >= 3 && alpha >= 1 && nums >= 1 && (alpha >= 2 || nums >= 2);

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Pressable onPress={props.onClose} hitSlop={8}>
          <Text style={styles.back}>◀ Back</Text>
        </Pressable>
        <Text style={styles.title}>Grid calibration — {props.levelCode}</Text>
        <Text style={styles.muted}>Drawing Position is read from these grids when a pin is placed or moved.</Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {props.error ? <Text style={styles.error}>{props.error}</Text> : null}

        <Text style={styles.label}>Grid sets</Text>
        {sets.length === 0 ? <Text style={styles.muted}>No grid on this sheet yet: the text pass found no bubbles. Calibrate by hand below.</Text> : null}
        {sets.map((gs, i) => (
          <SetRow key={`${i}:${gs.name}`} index={i} set={gs} canEdit={props.canEdit} onRename={props.onRename} onRemove={props.onRemove} />
        ))}

        <Text style={styles.label}>Test</Text>
        <Pressable style={[styles.btn, mode === 'test' && styles.btnOn]} onPress={props.onTest}>
          <Text style={[styles.btnText, mode === 'test' && styles.btnTextOn]}>{mode === 'test' ? 'Testing: tap a point on the plan (tap here to stop)' : 'Test: tap a point → its Drawing Position'}</Text>
        </Pressable>
        {props.testResult ? <Text style={styles.result}>{props.testResult.text ?? 'Off every grid on this sheet'}</Text> : null}

        <Text style={styles.label}>If wrong: calibrate by hand</Text>
        {mode !== 'calibrate' ? (
          <>
            <Text style={styles.muted}>Tap three bubbles on the plan — two of one axis (A and H, say) and one of the other (9) — and say which label each is. A fourth tap on the other axis fixes its spacing.</Text>
            <Pressable style={[styles.btn, !props.canEdit && styles.btnOff]} onPress={props.onStartCalibrate} disabled={!props.canEdit}>
              <Text style={styles.btnText}>Recalibrate: tap three bubbles</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              {taps.length} of 3 bubbles tapped{alpha || nums ? ` (${alpha} letter${alpha === 1 ? '' : 's'}, ${nums} number${nums === 1 ? '' : 's'})` : ''}.
            </Text>
            {taps.map((t, i) => (
              <Text key={i} style={styles.tap}>
                {i + 1}. {t.label} at {Math.round(t.x)}, {Math.round(t.y)}
              </Text>
            ))}
            {pending ? (
              <View style={styles.pending}>
                <Text style={styles.muted}>Which bubble is at {Math.round(pending.x)}, {Math.round(pending.y)}?{pending.suggestion ? ` Printed there: ${pending.suggestion}` : ''}</Text>
                <View style={styles.row}>
                  <TextInput
                    style={styles.input}
                    value={label}
                    onChangeText={setLabel}
                    placeholder="A, H, 9, C., 13.5…"
                    placeholderTextColor="#888"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoFocus
                    onSubmitEditing={() => label.trim() && props.onLabelPending(label.trim())}
                  />
                  <Pressable style={[styles.btn, !label.trim() && styles.btnOff]} disabled={!label.trim()} onPress={() => props.onLabelPending(label.trim())}>
                    <Text style={styles.btnText}>Use</Text>
                  </Pressable>
                  <Pressable style={styles.btnPlain} onPress={props.onDropPending}>
                    <Text style={styles.btnPlainText}>Drop</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Text style={styles.hint}>Tap the next bubble on the plan.</Text>
            )}
            {alpha >= 2 || nums >= 2 ? (
              <Text style={styles.muted}>Dashed rings: the bubbles this set would claim. If one sits beside its printed bubble instead of on it, a tap or a label is wrong: Undo tap.</Text>
            ) : null}
            <Text style={styles.label}>New set</Text>
            <TextInput style={styles.input} value={newName} onChangeText={setNewName} placeholder="Name (optional, e.g. Walter Tower)" placeholderTextColor="#888" />
            <TextInput style={styles.input} value={newPrefix} onChangeText={setNewPrefix} placeholder="Prefix for Drawing Position (e.g. WT)" placeholderTextColor="#888" autoCapitalize="characters" autoCorrect={false} />
            <View style={styles.row}>
              <Pressable style={[styles.btn, !canFinish && styles.btnOff]} disabled={!canFinish} onPress={() => props.onFinishCalibrate(newName.trim(), newPrefix.trim())}>
                <Text style={styles.btnText}>Finish</Text>
              </Pressable>
              <Pressable style={styles.btnPlain} onPress={props.onUndoTap} disabled={taps.length === 0}>
                <Text style={[styles.btnPlainText, taps.length === 0 && styles.disabled]}>Undo tap</Text>
              </Pressable>
              <Pressable style={styles.btnPlain} onPress={props.onCancelCalibrate}>
                <Text style={styles.btnPlainText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function SetRow({ index, set, canEdit, onRename, onRemove }: { index: number; set: GridSet; canEdit: boolean; onRename: GridPanelProps['onRename']; onRemove: GridPanelProps['onRemove'] }) {
  const [name, setName] = useState(set.name);
  const [prefix, setPrefix] = useState(set.prefix);
  const dirty = name.trim() !== set.name || prefix.trim() !== set.prefix;
  const color = GRID_SET_COLORS[index % GRID_SET_COLORS.length]!;
  const cols = set.col_labels;
  const rows = set.row_labels;
  const range = (l: typeof cols) => (l.length ? `${l[0]!.label}–${l[l.length - 1]!.label}` : '—');
  return (
    <View style={[styles.set, { borderLeftColor: color }]}>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.flex]} value={name} onChangeText={setName} editable={canEdit} placeholder="Name" placeholderTextColor="#888" />
        <TextInput style={[styles.input, styles.prefix]} value={prefix} onChangeText={setPrefix} editable={canEdit} placeholder="Prefix" placeholderTextColor="#888" autoCapitalize="characters" autoCorrect={false} />
      </View>
      <Text style={styles.setLine}>
        {set.mode === 'auto' ? '● auto' : set.mode === 'manual' ? '● manual' : '○ not usable — calibrate by hand'}
        {set.mode === 'auto' ? ` · residual ${set.residual.toFixed(1)} pt` : ''}
        {set.angle && Math.abs(set.angle) > 2 ? ` · rotated ${set.angle.toFixed(0)}°` : ''}
      </Text>
      <Text style={styles.setLine}>
        columns {range(cols)} ({cols.length}) · rows {range(rows)} ({rows.length}){prefix.trim() ? ` · "${prefix.trim()} Grid …"` : ''}
      </Text>
      {canEdit ? (
        <View style={styles.row}>
          <Pressable style={[styles.btnSmall, !dirty && styles.btnOff]} disabled={!dirty} onPress={() => onRename(index, name.trim() || set.name, prefix.trim())}>
            <Text style={styles.btnText}>Save</Text>
          </Pressable>
          <Pressable style={styles.btnPlain} onPress={() => onRemove(index)}>
            <Text style={styles.btnPlainText}>Remove</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  back: { fontSize: 15, color: '#1565c0', fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700' },
  body: { padding: 12, gap: 8, paddingBottom: 40 },
  label: { fontSize: 13, fontWeight: '700', color: '#333', marginTop: 6 },
  muted: { fontSize: 12, color: '#777' },
  hint: { fontSize: 13, color: '#1565c0', fontWeight: '600' },
  error: { color: '#b71c1c', fontSize: 13 },
  result: { fontSize: 16, fontWeight: '700', color: '#111' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 7, fontSize: 15, backgroundColor: '#fff', minWidth: 90 },
  prefix: { width: 90 },
  set: { borderLeftWidth: 4, paddingLeft: 8, gap: 4, paddingVertical: 4 },
  setLine: { fontSize: 12, color: '#555' },
  tap: { fontSize: 13, color: '#222' },
  pending: { gap: 6, padding: 8, borderRadius: 6, backgroundColor: '#e3f2fd' },
  btn: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: '#1565c0' },
  btnSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: '#1565c0' },
  btnOn: { backgroundColor: '#0d47a1' },
  btnOff: { opacity: 0.4 },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnTextOn: { color: '#fff' },
  btnPlain: { paddingHorizontal: 10, paddingVertical: 8 },
  btnPlainText: { color: '#1565c0', fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
