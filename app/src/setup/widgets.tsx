/**
 * Small form pieces shared by the project setup screens (T41). Since T174 (D266) they are the UI
 * system's primitives (`app/src/ui`) under their old names and props, so the screens that import
 * them change only when their own task comes (T180). Light theme only (app.json).
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Banner } from '../ui/Banner';
import { Btn as UiBtn } from '../ui/Btn';
import { Chip } from '../ui/Chip';
import { Field as UiField, fieldStyles } from '../ui/Field';
import { color, font, hit, radius, space } from '../ui/tokens';

export function Field({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
  multiline,
  width,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Called when the field loses focus (edits commit per field, D45). */
  onCommit?: () => void;
  placeholder?: string;
  multiline?: boolean;
  width?: number;
  /** `<screen>.<element>`: what a Maestro flow taps (T149). */
  testID?: string;
}) {
  return <UiField label={label} value={value} onChange={onChange} onCommit={onCommit} placeholder={placeholder} multiline={multiline} width={width} testID={testID} />;
}

export function Btn({
  title,
  onPress,
  primary,
  disabled,
  small,
  testID,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  small?: boolean;
  /** `<screen>.<element>`: what a Maestro flow taps (T149). */
  testID?: string;
}) {
  return <UiBtn title={title} onPress={onPress} kind={primary ? 'primary' : 'secondary'} disabled={disabled} small={small} testID={testID} />;
}

export function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: value }}>
      <Text style={[styles.checkBox, value && { color: color.primary }]}>{value ? '☑' : '☐'}</Text>
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
  testID,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  onPick: (id: string | null) => void;
  none?: string;
  disabled?: boolean;
  /** `<screen>.<element>`: the value is `testID`, the choices `testID.none` and `testID.<option id>` (T154). */
  testID?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value)?.label ?? none;
  return (
    <View style={styles.picker}>
      <Pressable
        onPress={() => !disabled && setOpen((o) => !o)}
        style={({ pressed }) => [styles.pickerValue, pressed && !disabled && { backgroundColor: color.surface2 }, disabled && styles.btnDisabled]}
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !!disabled }}
      >
        <Text style={styles.pickerText}>{current} ▾</Text>
      </Pressable>
      {open ? (
        <View style={styles.pickerList}>
          <Chip label={none} small selected={value == null} onPress={() => (setOpen(false), onPick(null))} testID={testID && `${testID}.none`} />
          {options.map((o) => (
            <Chip key={o.id} label={o.label} small selected={o.id === value} onPress={() => (setOpen(false), onPick(o.id))} testID={testID && `${testID}.${o.id}`} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * In scope as a switch with a large tap target (P-11: the bare Switch was hard to hit and missed
 * taps). The whole cell toggles; the Switch only shows the state, so one tap is one toggle.
 * Off reads "out of scope (far ends only)" (P-7).
 */
export function ScopeSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      hitSlop={8}
      style={styles.scope}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel="In scope">
      <View pointerEvents="none">
        <Switch value={value} trackColor={{ true: color.primary }} />
      </View>
      {value ? null : <Text style={styles.scopeOff}>out of scope (far ends only)</Text>}
    </Pressable>
  );
}

/** A table column header with a one-line explanation under it (P-7, P-11). */
export function HeadCell({ label, help, style }: { label: string; help?: string; style?: object }) {
  return (
    <View style={[style, { gap: 2 }]}>
      <Text style={styles.label}>{label}</Text>
      {help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
  );
}

/** What the levels-table columns mean, shown under their headers. */
export const LEVEL_HELP = {
  inScope: 'Off: not surveyed; the floor only holds far ends of cables from surveyed floors.',
  numbering: 'Levels in one group share punch, part, photo and C- numbers (06 and 06M).',
  splitOf: 'A part of another floor drawn on its own sheet (06M of 06); it is listed right after it.',
} as const;

/** A page section: a title over its content (the shell's page pattern, `docs/ui-plan.md` §4). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** A result line under an action: a success banner, or a danger one with `error` (a `Banner`, T174). */
export function Notice({ text, error, testID }: { text: string | null; error?: boolean; testID?: string }) {
  if (!text) return null;
  return <Banner tone={error ? 'danger' : 'success'} text={text} testID={testID} style={styles.notice} />;
}

/**
 * The styles screens reach into as `w.row`, `w.label`, `w.input` (and the rest, kept under their
 * names): the system's values. A screen's own task (T180) replaces them with the primitives.
 */
export const styles = StyleSheet.create({
  field: fieldStyles.field,
  fieldGrow: fieldStyles.grow,
  label: { ...font.captionBold, color: color.text2, textTransform: 'uppercase' },
  input: fieldStyles.input,
  inputMulti: fieldStyles.multi,
  btn: { height: hit.target, paddingHorizontal: 18, borderRadius: radius.control, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, justifyContent: 'center' },
  btnPrimary: { backgroundColor: color.primary, borderColor: color.primary },
  btnSmall: { height: hit.small, paddingHorizontal: space.md },
  btnDisabled: { opacity: 0.45 },
  btnText: { ...font.calloutBold, color: color.text },
  btnTextPrimary: { color: color.onPrimary },
  btnTextSmall: { fontSize: 13, lineHeight: 18 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: hit.target },
  checkBox: { fontSize: 20, color: color.text2 },
  checkLabel: { ...font.body, color: color.text },
  picker: { minWidth: 90 },
  pickerValue: { minHeight: hit.control, justifyContent: 'center', borderWidth: 1, borderColor: color.border, borderRadius: radius.control, paddingHorizontal: space.md, backgroundColor: color.surface },
  pickerText: { ...font.callout, color: color.text },
  pickerList: { marginTop: space.xs, borderWidth: 1, borderColor: color.border, borderRadius: radius.control, backgroundColor: color.surface, flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 6 },
  pickerItem: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.surface2 },
  pickerItemText: { ...font.caption, color: color.text },
  pickerItemOn: { fontWeight: '600', color: color.primary },
  section: { gap: space.md, marginBottom: space.xl },
  sectionTitle: { ...font.title, color: color.text },
  notice: { marginTop: space.xs, alignSelf: 'stretch' },
  noticeError: { color: color.danger },
  row: { flexDirection: 'row', gap: space.md, alignItems: 'flex-end' },
  scope: { minHeight: hit.target, minWidth: 80, justifyContent: 'center', gap: 2 },
  scopeOff: { ...font.caption, color: color.text3 },
  help: { ...font.caption, color: color.text3 },
});
