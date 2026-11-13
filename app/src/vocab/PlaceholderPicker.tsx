/**
 * Endpoint picker for an end that is not a device (T40, D26): the project's placeholders grouped
 * by kind, tap to choose; a box adds a new one (kind `custom`) and chooses it. "Manage…" opens the
 * Vocabulary screen. Render inside the end editor's panel.
 */

import { OpError, type Editor, type Store } from '@field-survey/core';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Chip, color, fieldStyles, font, radius, space } from '../ui';
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
          <Chip key={p.id} label={p.label} small selected={p.label === props.currentLabel} onPress={() => pick(p.id)} testID={`placeholder.pick.${p.label}`} />
        ))}
        {items && !items.length ? <Text style={styles.muted}>None yet. Add one below, or load the standard list under Manage.</Text> : null}
      </View>
      <View style={styles.wrap}>
        <TextInput value={text} onChangeText={setText} placeholder="New placeholder" placeholderTextColor={color.text3} style={styles.input} onSubmitEditing={add} testID="placeholder.new" />
        <Btn title="Add & use" kind="primary" onPress={add} disabled={!text.trim()} testID="placeholder.add" />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.wrap}>
        <Btn title="Manage…" kind="tertiary" small onPress={() => router.push({ pathname: '/vocabulary', params: { project: editor.projectId, tab: 'placeholders' } })} testID="placeholder.manage" />
        <Btn title="Cancel" kind="tertiary" small onPress={props.onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.sm, borderWidth: 1, borderColor: color.border, borderRadius: radius.control, padding: 10, backgroundColor: color.surface },
  title: { ...font.calloutBold, color: color.text },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  muted: { ...font.caption, color: color.text3 },
  input: { ...fieldStyles.input, flexGrow: 1, minWidth: 160 },
  error: { ...font.caption, color: color.danger },
});
