/**
 * "+ Device (field addition)" from the plan's long-press menu (T23, Phase 3 §4.6), in the side
 * panel: category → type from the library (or a model typed freely → draft type, D55) → the
 * drawing tag for stations/sensors (D93: other IDs come from the server) → Add. The new device's
 * card opens after Add. The pin goes where the surveyor long-pressed (shown as a grey "+" pin).
 */

import { OpError, deviceIdFor, tagDeviceId, type Editor, type Store } from '@field-survey/core';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { chipStyles } from '../plan/chips';
import { DEVICE_CATEGORIES } from '../plan/pins';
import { addFieldDevice, libraryChoices, matchModel, schemeFor, type LibraryChoice } from './model';

export type AddDeviceProps = {
  store: Store;
  editor: Editor;
  projectId: string;
  levelId: string;
  levelCode: string;
  sheetId: string;
  at: { x: number; y: number };
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
  const [tag, setTag] = useState('');
  const [room, setRoom] = useState('');
  const [takenBy, setTakenBy] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    libraryChoices(store, projectId).then(setAll, (e: unknown) => setError(String(e)));
  }, [store, projectId]);

  const choices = useMemo(() => (all ?? []).filter((c) => !category || c.category === category), [all, category]);
  const picked = typeId ? (all?.find((c) => c.id === typeId) ?? null) : null;
  const typedMatch = !picked && typed.trim() ? matchModel(all ?? [], typed) : null;
  const effective = picked ?? typedMatch;
  const effectiveCategory = effective?.category ?? category;
  const scheme = schemeFor(effective, effectiveCategory);

  let tagPreview: string | null = null;
  let tagError: string | null = null;
  if (scheme === 'level_tag' && tag.trim()) {
    try {
      tagPreview = tagDeviceId(levelCode, effectiveCategory, tag);
    } catch (e) {
      tagError = (e as Error).message;
    }
  }

  useEffect(() => {
    if (!tagPreview) return setTakenBy([]);
    let active = true;
    deviceIdFor(store, { projectId, levelId, category: effectiveCategory, libraryTypeId: effective?.id ?? null, tag }).then(
      (p) => active && setTakenBy(p.pending ? [] : p.taken_by),
      () => active && setTakenBy([]),
    );
    return () => {
      active = false;
    };
  }, [store, projectId, levelId, effectiveCategory, effective?.id, tag, tagPreview]);

  const ready = !!effectiveCategory && (!!picked || !!typed.trim()) && (scheme === 'level_number' || !!tagPreview);

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
        tag: scheme === 'level_tag' ? tag : null,
        room,
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
        <Pressable onPress={props.onCancel} hitSlop={8} disabled={saving}>
          <Text style={styles.back}>◀ Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Add device (field addition)</Text>
        <Text style={styles.muted}>Placed where you pressed (the grey + pin).</Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.label}>Category</Text>
        <View style={styles.rowWrap}>
          {DEVICE_CATEGORIES.map((c) => (
            <Chip
              key={c}
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
          <View style={styles.rowWrap}>
            {choices.map((c) => (
              <Chip
                key={c.id}
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
        ) : (
          <Text style={styles.muted}>{category ? `No ${category} types in the library yet.` : 'No types in the library yet.'} Type the model below.</Text>
        )}
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={(t) => {
            setTyped(t);
            if (t) setTypeId(null);
          }}
          placeholder="…or type the model (e.g. ERP-RTO)"
          placeholderTextColor="#888"
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
        {scheme === 'level_tag' ? (
          <>
            <TextInput
              style={styles.input}
              value={tag}
              onChangeText={setTag}
              placeholder={`Drawing tag, e.g. ${effectiveCategory === 'Sensor' ? 'D3' : 'S15'}`}
              placeholderTextColor="#888"
              autoCapitalize="characters"
              autoCorrect={false}
            />
            {tagPreview ? <Text style={styles.idPreview}>{tagPreview}</Text> : null}
            {tagError ? <Text style={styles.error}>{tagError}</Text> : null}
            {takenBy.length ? <Text style={styles.warn}>⚠ {tagPreview} is already used in this project; you can still add it (it will be flagged).</Text> : null}
          </>
        ) : (
          <View style={styles.rowWrap}>
            <Text style={styles.idPreview}>{levelCode}-?</Text>
            <Text style={[chipStyles.badge]}>NEW</Text>
            <Text style={styles.muted}>numbered by the server at the next sync (D93)</Text>
          </View>
        )}

        <Text style={styles.label}>Room / Location (optional)</Text>
        <TextInput style={styles.input} value={room} onChangeText={setRoom} placeholder="e.g. XX06M-1E05 Elec Rm" placeholderTextColor="#888" />

        <Pressable style={[styles.addBtn, (!ready || saving) && styles.addBusy]} onPress={add} disabled={!ready || saving}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.addText}>Add device</Text>}
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Chip({ label, on, onPress, badge }: { label: string; on: boolean; onPress: () => void; badge?: string }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {badge ? <Text style={[chipStyles.badge, chipStyles.badgeDraft]}>{badge}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  back: { fontSize: 15, color: '#1565c0', fontWeight: '600' },
  title: { fontSize: 18, fontWeight: '700' },
  body: { padding: 12, gap: 8, paddingBottom: 40 },
  label: { fontSize: 13, fontWeight: '700', color: '#333', marginTop: 4 },
  muted: { fontSize: 12, color: '#777' },
  note: { fontSize: 12, color: '#6a1b9a' },
  warn: { fontSize: 12, color: '#e65100' },
  error: { color: '#b71c1c', fontSize: 13 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { fontSize: 13, color: '#222' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 7, fontSize: 15, backgroundColor: '#fff' },
  idPreview: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  addBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 12, borderRadius: 8, backgroundColor: '#1565c0' },
  addBusy: { opacity: 0.5 },
  addText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
