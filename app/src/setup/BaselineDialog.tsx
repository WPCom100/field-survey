/**
 * The Lock / Unlock baseline dialog (T47, Phase 3 §3.5, D57, D164), shared by Setup (Levels and
 * Lock baseline steps) and the Levels screen. Lock asks once, listing what it leaves behind
 * ("Lock anyway"); Unlock needs a typed reason.
 */

import { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, TextInput, View } from 'react-native';

import { openAppStore } from '../db';
import { BaselineActions, lockQuestion, lockWarnings, type LockLevel } from './lock';
import { SetupError } from './model';
import { Btn, styles as w } from './widgets';

/** iOS presents a Modal in portrait unless told otherwise, and the app is landscape-only. */
const ORIENTATIONS = ['landscape-left', 'landscape-right'] as const;

export function BaselineDialog({
  projectId,
  userId,
  level,
  onClose,
}: {
  projectId: string;
  userId: string;
  /** The level to lock or unlock; null hides the dialog. */
  level: LockLevel | null;
  /** Called with a notice after a lock or unlock, with null on Cancel. */
  onClose: (done: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [level?.id]);

  if (!level) return null;
  const warnings = lockWarnings(level);
  const unlocking = level.locked;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const actions = new BaselineActions(await openAppStore(), projectId, userId);
      if (unlocking) await actions.unlock(level.id, reason);
      else await actions.lock(level.id);
      onClose(unlocking ? `${level.code} unlocked: back to setup` : `${level.code} baseline locked: changes are logged from now on`);
    } catch (e) {
      setError(e instanceof SetupError ? e.message : `Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" supportedOrientations={[...ORIENTATIONS]} onRequestClose={() => onClose(null)}>
      <View style={styles.scrim}>
        <View style={styles.box}>
          <Text style={styles.title}>{unlocking ? `Unlock ${level.code}?` : lockQuestion(level)}</Text>
          {unlocking ? (
            <>
              <Text style={styles.body}>
                {level.code} goes back to Setup. Edits stay in the history; the baseline is locked again from Setup or the Levels screen.
              </Text>
              <TextInput
                style={w.input}
                value={reason}
                onChangeText={setReason}
                placeholder="Why unlock? (kept in the history)"
                placeholderTextColor="#9aa0a8"
                autoFocus
              />
            </>
          ) : (
            <Text style={styles.body}>
              Change logging starts now: every later edit on {level.code} shows who, when, was → now and why in History.
              {warnings.length ? ' What is listed above stays open after the lock.' : ''}
            </Text>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Btn title="Cancel" onPress={() => onClose(null)} />
            <Btn
              title={unlocking ? 'Unlock' : warnings.length ? 'Lock anyway' : `Lock ${level.code}`}
              primary
              disabled={busy || (unlocking && !reason.trim())}
              onPress={() => void confirm()}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  box: { width: 480, backgroundColor: '#fff', borderRadius: 12, padding: 20, gap: 12 },
  title: { fontSize: 19, fontWeight: '700' },
  body: { fontSize: 15, color: '#333' },
  error: { fontSize: 14, color: '#c62828' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
});
