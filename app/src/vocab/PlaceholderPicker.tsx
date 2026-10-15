/**
 * Endpoint picker for an end that is not a device (T40, D26): the project's placeholders grouped
 * by kind, tap to choose; a box adds a new one (kind `custom`) and chooses it. "Manage…" opens the
 * Vocabulary screen. Render inside the end editor's panel.
 */

import { OpError, type Editor, type Store } from '@field-survey/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { addPlaceholder, loadPlaceholders, type PlaceholderEntry } from './model';

export function PlaceholderPicker(props: { store: Store; editor: Editor; currentLabel: string | null; onPick: (placeholderId: string) => Promise<unknown>; onClose: () => void }) {
  const { store, editor, onPick } = props;
  const [items, setItems] = useState<PlaceholderEntry[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadPlaceholders(store, editor.projectId).then((p) => live && setItems(p), (e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [store, editor.projectId]);

  const pick = async (id: string) => {
    try {
      await onPick(id);
      props.onClose();
    } catch (e) {
      setError(e instanceof OpError ? e.message : String(e));
    }
  };
  const add = async () => {
    try {
      await pick(await addPlaceholder(editor, store, text));
    } catch (e) {
      setError(e instanceof OpError ? e.message : String(e));
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title}>Choose a placeholder</Text>
      <View style={styles.wrap}>
        {(items ?? []).map((p) => (
          <Pressable key={p.id} onPress={() => pick(p.id)} style={[styles.chip, p.label === props.currentLabel && styles.chipOn]}>
            <Text style={p.label === props.currentLabel ? styles.chipTextOn : styles.chipText}>{p.label}</Text>
          </Pressable>
        ))}
        {items && !items.length ? <Text style={styles.muted}>None yet. Add one below, or load the standard list under Manage.</Text> : null}
      </View>
      <View style={styles.wrap}>
        <TextInput value={text} onChangeText={setText} placeholder="New placeholder" placeholderTextColor="#888" style={styles.input} onSubmitEditing={add} />
        <Pressable onPress={add} disabled={!text.trim()} style={[styles.btn, !text.trim() && styles.off]}>
          <Text style={styles.btnText}>Add & use</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.wrap}>
        <Pressable onPress={() => router.push({ pathname: '/vocabulary', params: { project: editor.projectId, tab: 'placeholders' } })}>
          <Text style={styles.link}>Manage…</Text>
        </Pressable>
        <Pressable onPress={props.onClose}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8, borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10 },
  title: { fontSize: 14, fontWeight: '700' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: '#c9ccd1' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipText: { color: '#111' },
  chipTextOn: { color: '#fff' },
  muted: { fontSize: 13, color: '#666' },
  input: { flexGrow: 1, minWidth: 160, borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 8, padding: 10, fontSize: 16, minHeight: 44 },
  btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1565c0' },
  btnText: { color: '#fff', fontWeight: '600' },
  off: { opacity: 0.4 },
  link: { color: '#1f6feb', fontSize: 15 },
  error: { color: '#b3261e', fontSize: 14 },
});
