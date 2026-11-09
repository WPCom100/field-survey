import { Pressable, StyleSheet, Text } from 'react-native';

import { useBlobStatus } from '../blobs/useBlobStatus';
import { describeBlobs, describeSync, statusTone, type StatusTone } from '../sync/describe';
import { getSyncEngine } from '../sync/engine';
import { useSyncStatus } from '../sync/useSyncStatus';
import { color, font, Icon, space, tabular, type IconName } from '../ui';

const TONE: Record<StatusTone, { bg: string; fg: string; icon: IconName; iconColor: string }> = {
  ok: { bg: color.surface, fg: color.text2, icon: 'check', iconColor: color.success },
  busy: { bg: color.surface, fg: color.text2, icon: 'sync', iconColor: color.text2 },
  warn: { bg: color.warningTint, fg: color.warning, icon: 'offline', iconColor: color.warning },
  error: { bg: color.dangerTint, fg: color.danger, icon: 'error', iconColor: color.danger },
};

/**
 * The status strip (T18; the "Levels · the shell" board since T176): 28 pt over every screen, one
 * line of sync state, edits and photos waiting, tinted when the iPad is offline, has something
 * waiting or needs a sign-in. Tap to sync now.
 */
export function GlobalStatusBar() {
  const sync = useSyncStatus();
  const blobs = useBlobStatus();
  const tone = statusTone(sync, blobs);
  const t = TONE[tone];
  // Waiting edits while online are not "offline": the icon says sync, not a struck cloud.
  const icon: IconName = tone === 'warn' && sync.state !== 'offline' && sync.state !== 'no_token' ? (sync.state === 'error' ? 'lock' : 'sync') : t.icon;
  return (
    <Pressable
      onPress={() => getSyncEngine().then((e) => e.requestSync())}
      style={[styles.bar, { backgroundColor: t.bg }]}
      accessibilityRole="button"
      // No accessibilityLabel: it replaced the text, so VoiceOver and Maestro read "Sync status"
      // instead of the line. Flows assert the text through the testID (T154).
      accessibilityHint="Sync now"
      testID="status.bar"
      hitSlop={{ bottom: 8 }}
    >
      <Icon name={icon} size={14} color={t.iconColor} strokeWidth={tone === 'ok' ? 2.4 : 2} />
      <Text style={[styles.text, { color: t.fg }]} numberOfLines={1}>
        {describeSync(sync, describeBlobs(blobs))}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  text: { ...font.caption, ...tabular, flexShrink: 1 },
});
