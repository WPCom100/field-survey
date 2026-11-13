/**
 * "+ Device (field addition)" from the plan's long-press menu (T23, Phase 3 §4.6), in the side
 * panel: category → type from the library (or a model typed freely → draft type, D55) → Add.
 * Every ID comes from the server (D93, D118): the device shows `<level>-?` + NEW until then. The new device's
 * card opens after Add. The pin goes where the surveyor long-pressed (shown as a grey "+" pin).
 * The model box searches the choices as you type (T114: model, alias, catalogue name; the
 * Library screen's search), and shows at most `SHOWN` chips.
 */

import { OpError, type Editor, type Store } from '@field-survey/core';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { chipStyles } from '../plan/chips';
import { DEVICE_CATEGORIES } from '../plan/pins';
import { Btn, color, fieldStyles, font, hit, hitSlopTo, radius, space, tabular } from '../ui';
import { addFieldDevice, libraryChoices, matchModel, searchChoices, type LibraryChoice } from './model';

/** Chips shown at once: the app library holds about 500 placeable types after the DaVinci import. */
const SHOWN = 60;

export type AddDeviceProps = {
  store: Store;
  editor: Editor;
  projectId: string;
  levelId: string;
  levelCode: string;
  /** Where the surveyor long-pressed; null from Needs review (T81): created unplaced. */
  sheetId: string | null;
  at: { x: number; y: number } | null;
  /** Header line; default "Add device (field addition)". */
  title?: string;
  /** Defaults from the sheet's grid calibration and text pass at `at` (T45): editable. */
  defaults?: { drawingPosition: string | null; room: string | null };
  onCancel: () => void;
  /** Category picked so far: the plan draws the placeholder pin in its shape. */
  onCategory: (category: string | null) => void;
  onAdded: (deviceId: string) => void;
};

export function AddDevicePanel(props: AddDeviceProps) {
  const { store, editor, projectId, levelId, levelCode } = props;
  const [category, setCategory] = useState<string | null>(null);
  const [all, setAll] = useState<LibraryChoice[] | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [room, setRoom] = useState(props.defaults?.room ?? '');
  const [drawingPosition, setDrawingPosition] = useState(props.defaults?.drawingPosition ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    libraryChoices(store, projectId).then(setAll, (e: unknown) => setError(String(e)));
  }, [store, projectId]);

  const picked = typeId ? (all?.find((c) => c.id === typeId) ?? null) : null;
  const matching = useMemo(() => searchChoices((all ?? []).filter((c) => !category || c.category === category), typed), [all, category, typed]);
  // the picked chip stays in view even past the cut
  const choices = useMemo(() => {
    const head = matching.slice(0, SHOWN);
    return picked && !head.includes(picked) ? [picked, ...head] : head;
  }, [matching, picked]);
  const hidden = Math.max(0, matching.length - SHOWN);
  const typedMatch = !picked && typed.trim() ? matchModel(all ?? [], typed) : null;
  const effective = picked ?? typedMatch;
  const effectiveCategory = effective?.category ?? category;
  const ready = !!effectiveCategory && (!!picked || !!typed.trim());

  const add = async () => {
    if (!ready || !effectiveCategory) return;
    setSaving(true);
    setError(null);
    try {
      const r = await addFieldDevice(editor, store, {
        projectId,
        levelId,
        sheetId: props.sheetId,
        at: props.at,
        category: effectiveCategory,
        libraryTypeId: picked?.id ?? null,
        typedModel: picked ? null : typed,
        room,
        drawingPosition,
      });
      props.onAdded(r.deviceId);
    } catch (e) {
      setError(e instanceof OpError ? e.message : `Not added: ${String((e as Error)?.message ?? e)}`);
      setSaving(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Pressable onPress={props.onCancel} hitSlop={8} disabled={saving} testID="add.cancel" style={styles.backBtn}>
          <Text style={styles.back}>◀ Cancel</Text>
        </Pressable>
        <Text style={styles.title}>{props.title ?? 'Add device (field addition)'}</Text>
        <Text style={styles.muted}>{props.at ? 'Placed where you pressed (the grey + pin).' : 'Not on the plan yet: place its pin from the plan later.'}</Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.label}>Category</Text>
        <View style={styles.rowWrap}>
          {DEVICE_CATEGORIES.map((c) => (
            <Chip
              key={c}
              testID={`add.cat.${c}`}
              label={c}
              on={effectiveCategory === c}
              onPress={() => {
                setCategory(c);
                props.onCategory(c);
                if (picked && picked.category !== c) setTypeId(null);
              }}
            />
          ))}
        </View>

        <Text style={styles.label}>Type {category ? `(${category})` : ''}</Text>
        {!all ? (
          <ActivityIndicator />
        ) : choices.length ? (
          <>
          <View style={styles.rowWrap}>
            {choices.map((c) => (
              <Chip
                key={c.id}
                testID={`add.type.${c.model}`}
                label={`${c.model}${c.projectId ? '' : ' · app'}`}
                badge={c.state === 'draft' ? 'DRAFT' : undefined}
                on={typeId === c.id}
                onPress={() => {
                  setTypeId(typeId === c.id ? null : c.id);
                  setTyped('');
                  if (c.category) {
                    setCategory(c.category);
                    props.onCategory(c.category);
                  }
                }}
              />
            ))}
          </View>
          {hidden > 0 ? <Text style={styles.muted}>{hidden} more: type in the box below to narrow.</Text> : null}
          </>
        ) : typed.trim() && all.length ? (
          <Text style={styles.muted}>No library type matches “{typed.trim()}”{category ? ` in ${category}` : ''}.</Text>
        ) : (
          <Text style={styles.muted}>{category ? `No ${category} types in the library yet.` : 'No types in the library yet.'} Type the model below.</Text>
        )}
        <TextInput
          style={styles.input}
          testID="add.model"
          value={typed}
          onChangeText={(t) => {
            setTyped(t);
            if (t) setTypeId(null);
          }}
          placeholder="Search the types, or type a new model (e.g. ERP-RTO)"
          placeholderTextColor={color.text3}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {typed.trim() ? (
          typedMatch ? (
            <Text style={styles.muted}>Matches the library type {typedMatch.model}.</Text>
          ) : (
            <Text style={styles.note}>New model: added to this project's library as a draft for review (D55).</Text>
          )
        ) : null}

        <Text style={styles.label}>ID</Text>
        <View style={styles.rowWrap}>
          <Text style={styles.idPreview}>{levelCode}-?</Text>
          <Text style={[chipStyles.badge]}>NEW</Text>
          <Text style={styles.muted}>numbered by the server at the next sync</Text>
        </View>

        <Text style={styles.label}>Drawing Position (optional)</Text>
        <TextInput style={styles.input} value={drawingPosition} onChangeText={setDrawingPosition} placeholder="e.g. Grid B-C / 9-8" placeholderTextColor={color.text3} autoCorrect={false} />
        {props.defaults?.drawingPosition ? <Text style={styles.muted}>From the grid at the pin; edit if the drawing says otherwise.</Text> : null}

        <Text style={styles.label}>Room / Location (optional)</Text>
        <TextInput testID="add.room" style={styles.input} value={room} onChangeText={setRoom} placeholder="e.g. XX06M-1E05 Elec Rm" placeholderTextColor={color.text3} />
        {props.defaults?.room ? <Text style={styles.muted}>The room code printed nearest the pin.</Text> : null}

        <Btn title="Add device" kind="primary" onPress={add} disabled={!ready} loading={saving} style={styles.addBtn} testID="add.submit" />
      </ScrollView>
    </View>
  );
}

/** The system's small chip (32 pt, `hitSlop` to 44) with a DRAFT badge after the label. */
function Chip({ label, on, onPress, badge, testID }: { label: string; on: boolean; onPress: () => void; badge?: string; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlopTo(32)}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && !on && styles.chipPressed]}
      testID={testID}>
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {badge ? <Text style={[chipStyles.badge, chipStyles.badgeDraft]}>{badge}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  flex: { flex: 1 },
  head: { paddingHorizontal: space.md, paddingTop: 10, paddingBottom: space.sm, gap: 3, borderBottomWidth: 1, borderBottomColor: color.hairline },
  backBtn: { alignSelf: 'flex-start', minHeight: hit.small, justifyContent: 'center' },
  back: { ...font.calloutBold, color: color.primary },
  title: { ...font.headline, color: color.text },
  body: { padding: space.md, gap: space.sm, paddingBottom: 40 },
  label: { ...font.captionBold, color: color.text2, marginTop: space.xs },
  muted: { ...font.caption, color: color.text3 },
  note: { ...font.caption, color: color.primary },
  error: { ...font.caption, color: color.danger },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: '100%', height: 32, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  chipOn: { backgroundColor: color.primaryTint, borderColor: color.primaryTint },
  chipPressed: { backgroundColor: color.surface2 },
  chipText: { ...font.caption, color: color.text, flexShrink: 1 },
  chipTextOn: { color: color.primary, fontWeight: '600' },
  // 36 pt as the side-panel editors (D279 (5)): at 44 the Room box slid under the keyboard
  input: { ...fieldStyles.input, minHeight: hit.small, paddingHorizontal: space.sm, paddingVertical: 7, ...font.callout },
  idPreview: { ...font.headline, ...tabular, color: color.text },
  addBtn: { marginTop: space.md, alignSelf: 'stretch' },
});
