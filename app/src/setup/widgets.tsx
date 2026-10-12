/** Small form pieces shared by the project setup screens (T41). Light theme only (app.json). */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export function Field({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
  multiline,
  width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Called when the field loses focus (edits commit per field, D45). */
  onCommit?: () => void;
  placeholder?: string;
  multiline?: boolean;
  width?: number;
}) {
  return (
    <View style={[styles.field, width ? { width } : styles.fieldGrow]}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMulti]}
        value={value}
        onChangeText={onChange}
        onBlur={onCommit}
        placeholder={placeholder}
        placeholderTextColor="#9aa0a8"
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
      />
    </View>
  );
}

export function Btn({
  title,
  onPress,
  primary,
  disabled,
  small,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, primary && styles.btnPrimary, small && styles.btnSmall, disabled && styles.btnDisabled]}
    >
      <Text style={[styles.btnText, primary && styles.btnTextPrimary, small && styles.btnTextSmall]}>{title}</Text>
    </Pressable>
  );
}

export function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.check}>
      <Text style={styles.checkBox}>{value ? '☑' : '☐'}</Text>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * A value with a list of choices that opens inline when tapped (no native picker on iPad that
 * fits a table row). `none` is the label of the empty choice.
 */
export function ChipPicker({
  value,
  options,
  onPick,
  none = '—',
  disabled,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  onPick: (id: string | null) => void;
  none?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value)?.label ?? none;
  return (
    <View style={styles.picker}>
      <Pressable onPress={() => !disabled && setOpen((o) => !o)} style={[styles.pickerValue, disabled && styles.btnDisabled]}>
        <Text style={styles.pickerText}>{current} ▾</Text>
      </Pressable>
      {open ? (
        <View style={styles.pickerList}>
          <Pressable onPress={() => (setOpen(false), onPick(null))} style={styles.pickerItem}>
            <Text style={styles.pickerItemText}>{none}</Text>
          </Pressable>
          {options.map((o) => (
            <Pressable key={o.id} onPress={() => (setOpen(false), onPick(o.id))} style={styles.pickerItem}>
              <Text style={[styles.pickerItemText, o.id === value && styles.pickerItemOn]}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Notice({ text, error }: { text: string | null; error?: boolean }) {
  if (!text) return null;
  return <Text style={[styles.notice, error && styles.noticeError]}>{text}</Text>;
}

export const styles = StyleSheet.create({
  field: { gap: 4 },
  fieldGrow: { flex: 1 },
  label: { fontSize: 12, fontWeight: '700', color: '#555', textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, backgroundColor: '#fff', color: '#111' },
  inputMulti: { minHeight: 70, textAlignVertical: 'top' },
  btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6, borderWidth: 1, borderColor: '#1565c0', backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: '#1565c0' },
  btnSmall: { paddingHorizontal: 8, paddingVertical: 5 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#1565c0', fontSize: 15, fontWeight: '600' },
  btnTextPrimary: { color: '#fff' },
  btnTextSmall: { fontSize: 13 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  checkBox: { fontSize: 18 },
  checkLabel: { fontSize: 15 },
  picker: { minWidth: 90 },
  pickerValue: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: '#fff' },
  pickerText: { fontSize: 14 },
  pickerList: { marginTop: 4, borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, backgroundColor: '#fff', flexDirection: 'row', flexWrap: 'wrap', gap: 2, padding: 4 },
  pickerItem: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 4, backgroundColor: '#f3f5f8' },
  pickerItemText: { fontSize: 14 },
  pickerItemOn: { fontWeight: '700', color: '#1565c0' },
  section: { gap: 10, marginBottom: 22 },
  sectionTitle: { fontSize: 20, fontWeight: '600' },
  notice: { fontSize: 14, color: '#2e7d32', marginTop: 4 },
  noticeError: { color: '#c62828' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-end' },
});
