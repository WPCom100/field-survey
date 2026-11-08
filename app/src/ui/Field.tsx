/** A labelled text field (the board's Fields): label, 44-pt input, hint or error, focused border. */

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { color, font, hit, radius, space } from './tokens';

export type FieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Called when the field loses focus (edits commit per field, D45). */
  onCommit?: () => void;
  placeholder?: string;
  /** Caption under the field. */
  hint?: string;
  /** Replaces the hint and turns the border and label red. */
  error?: string | null;
  multiline?: boolean;
  /** Fixed width; grows to fill its row otherwise. */
  width?: number;
  disabled?: boolean;
  /** `<screen>.<element>`: the input is what a Maestro flow taps (T149). */
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Anything else the `TextInput` takes (keyboard type, secure entry, return key, …). */
  inputProps?: Omit<TextInputProps, 'value' | 'onChangeText' | 'onBlur' | 'placeholder' | 'multiline' | 'testID' | 'style' | 'editable'>;
};

export function Field({ label, value, onChange, onCommit, placeholder, hint, error, multiline, width, disabled, testID, style, inputProps }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const tone = error ? color.danger : focused ? color.primary : null;
  const sub = error ?? hint;
  return (
    <View style={[styles.field, width ? { width } : styles.grow, style]}>
      <Text style={[styles.label, tone ? { color: tone } : null]}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multi, tone ? { borderColor: tone, borderWidth: 2, paddingHorizontal: space.md - 1 } : null, disabled && styles.off]}
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onCommit?.();
        }}
        placeholder={placeholder}
        placeholderTextColor={color.text3}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        editable={!disabled}
        testID={testID}
        {...inputProps}
      />
      {sub ? <Text style={[styles.sub, error ? { color: color.danger } : null]}>{sub}</Text> : null}
    </View>
  );
}

export const fieldStyles = StyleSheet.create({
  field: { gap: 6 },
  grow: { flex: 1 },
  label: { ...font.captionBold, color: color.text2 },
  input: {
    minHeight: hit.target,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    ...font.body,
    backgroundColor: color.surface,
    color: color.text,
  },
  multi: { minHeight: 88, textAlignVertical: 'top' },
  off: { backgroundColor: color.surface2, color: color.text3 },
  sub: { ...font.caption, color: color.text3 },
});
const styles = fieldStyles;
