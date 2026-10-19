import Constants from 'expo-constants';
import { Link } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { getBlobFiles, getBlobQueue } from '../blobs/queue';
import { useBlobStatus } from '../blobs/useBlobStatus';
import { openAppStore } from '../db';
import { listProjects } from '../home/data';
import { useIdentity, useSignOut } from '../identity/IdentityGate';
import { exportLog } from '../log';
import { lastRulesPass } from '../rules/engine';
import { getSyncEngine } from '../sync/engine';
import { loadInstallLabels, saveInstallLabel } from '../sync/install';
import { describeCycle, formatBytes, freeUploadedPhotos, loadServerVersion, loadSyncScreen, retryFailedUploads, type SyncScreenData } from '../sync/screen';
import { checkAndFetch, runningInfo, useUpdateCheckState } from '../sync/useAppUpdates';
import { describeCheck, describeRunning } from '../sync/updates';
import { describeSync, useSyncStatus } from '../sync/useSyncStatus';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Sync & uploads (T25, Phase 3 §12). Sync and uploads use any network, cellular included (D121). */
export default function SyncScreen() {
  const identity = useIdentity();
  const signOut = useSignOut();
  const sync = useSyncStatus();
  const blobs = useBlobStatus();
  const [data, setData] = useState<SyncScreenData | null>(null);
  const [installId, setInstallId] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [labelFocused, setLabelFocused] = useState(false);
  const [hasProject, setHasProject] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [serverVersion, setServerVersion] = useState('');
  const updates = useUpdateCheckState();
  const info = runningInfo();
  const running = describeRunning(info);
  const checkLine = describeCheck(updates);

  const load = useCallback(async () => {
    const store = await openAppStore();
    const [project] = await listProjects(store);
    setInstallId(store.installId);
    setProjectId(project?.id ?? null);
    if (!labelFocused) setLabel((await loadInstallLabels(store)).get(store.installId) ?? '');
    setHasProject(!!project);
    setData(await loadSyncScreen(store, project?.id ?? null));
  }, [labelFocused]);

  useEffect(() => {
    load().catch((e: unknown) => setNote(String(e)));
  }, [load, sync.lastSyncAt, sync.pendingOps, blobs.photosWaiting, blobs.uploadsFailed, blobs.downloadsPending, blobs.cacheBytes]);

  // Re-read when sync state changes, so a deploy shows up once the iPad is online again.
  useEffect(() => {
    void loadServerVersion(identity.serverUrl).then(setServerVersion);
  }, [identity.serverUrl, sync.lastSyncAt, sync.state]);

  const run = (fn: () => Promise<string | void>) => () =>
    fn().then(
      (m) => {
        if (m) setNote(m);
        return load();
      },
      (e: unknown) => setNote(String(e)),
    );

  const seq = Object.values(sync.lastServerSeq).reduce((a, b) => Math.max(a, b), 0);
  const online = sync.state === 'idle' || sync.state === 'syncing';
  const build = Constants.platform?.ios?.buildNumber ?? '—';
  const version = Constants.expoConfig?.version ?? '—';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.head}>
        <Text style={styles.title}>Sync & uploads</Text>
        <Link href="/" style={styles.link}>
          ← Levels
        </Link>
      </View>
      <Text style={styles.hint}>
        Edits never need sign-in or a connection. Sync, setup uploads and exports do. Sync and uploads use whatever network the iPad has, cellular included.
      </Text>

      <Section label="Connection">
        <Text style={styles.value}>
          {online ? '● Online' : '● Not connected'} · {describeSync(sync)}
        </Text>
        <Text style={styles.sub}>
          Last successful sync {time(sync.lastSyncAt)}
          {seq ? ` (seq ${seq.toLocaleString()})` : ''}
        </Text>
        <Text style={styles.sub}>{describeCycle(sync.lastCycle, lastRulesPass())}</Text>
        {hasProject === false ? (
          <Text style={styles.sub}>
            No project on this iPad yet, so there is nothing to push or pull; "Synced" means the server answered. The demo plan never syncs.
          </Text>
        ) : null}
        {sync.nextAttemptAt && !online ? <Text style={styles.sub}>Next try {time(sync.nextAttemptAt)}</Text> : null}
        <Btn
          label="Sync now"
          onPress={run(async () => {
            await (await getSyncEngine()).requestSync();
          })}
        />
      </Section>

      <Section label="Pending edits">
        <Text style={styles.value}>
          {data?.outbox.pending ?? sync.pendingOps}
          {data?.outbox.oldestAt ? ` · oldest ${time(data.outbox.oldestAt)}` : ''}
        </Text>
        <Text style={styles.sub}>Sent in order when online; nothing is lost.</Text>
        {data?.outbox.failing ? (
          <Text style={styles.warn}>
            {data.outbox.failing} edit{data.outbox.failing === 1 ? '' : 's'} failed to send: {data.outbox.lastError ?? 'unknown error'}
          </Text>
        ) : null}
        {data?.outbox.quarantined.length ? (
          <>
            <Text style={styles.warn}>
              {data.outbox.quarantined.length} edit{data.outbox.quarantined.length === 1 ? '' : 's'} the server refused. The other edits keep syncing; these wait here until Retry.
            </Text>
            {data.outbox.quarantined.map((q) => (
              <Text key={q.opId} style={styles.sub}>
                {q.what} · {time(q.at)} · {q.attempts} {q.attempts === 1 ? 'try' : 'tries'}: {q.error ?? 'unknown error'}
              </Text>
            ))}
            <Btn
              label="Retry refused edits"
              onPress={run(async () => {
                const n = await (await getSyncEngine()).retryQuarantined();
                return `${n} edit${n === 1 ? '' : 's'} sent again.`;
              })}
            />
          </>
        ) : null}
      </Section>

      <Section label="Photos waiting">
        <Text style={styles.value}>
          {blobs.photosWaiting} photo{blobs.photosWaiting === 1 ? '' : 's'} · {blobs.uploadsPending} file{blobs.uploadsPending === 1 ? '' : 's'} (
          {formatBytes(blobs.uploadBytesPending)}), thumbnails first
        </Text>
        {data?.failedUploads.map((f) => (
          <Text key={f.sha256} style={styles.warn}>
            Upload failed ({f.kind}, {f.attempts} tries): {f.error ?? 'unknown'}
          </Text>
        ))}
        {blobs.lastError ? <Text style={styles.sub}>Last error: {blobs.lastError}</Text> : null}
        <Btn
          label="Retry failed uploads"
          disabled={!data?.failedUploads.length}
          onPress={run(async () => {
            const n = await retryFailedUploads(await openAppStore());
            await (await getBlobQueue()).requestRun();
            return `${n} upload${n === 1 ? '' : 's'} queued again.`;
          })}
        />
      </Section>

      <Section label="Review items">
        <Text style={styles.value}>
          {data?.openReviews ?? 0} open{sync.willReview ? ` · ${sync.willReview} of my pending edits will be reviewed` : ''}
        </Text>
        <Link href="/review" style={styles.link}>
          Open Needs review →
        </Link>
      </Section>

      <Section label="Cached levels">
        <View style={styles.wrap}>
          {data?.levels.map((l) => (
            <Text key={l.id} style={styles.chip}>
              {l.code} {l.cache === 'cached' ? '✓' : l.cache === 'downloading' ? '…' : '⬇'}
            </Text>
          ))}
          {data && !data.levels.length ? (
            <Text style={styles.sub}>{hasProject ? 'No plan sheets yet.' : 'No levels on this iPad yet (a project arrives with setup).'}</Text>
          ) : null}
        </View>
        <Btn
          label="Download assigned levels"
          disabled={data ? !data.levels.length : false}
          onPress={run(async () => {
            const q = await getBlobQueue();
            await q.prefetch();
            const n = await countQueuedDownloads();
            await q.requestRun();
            if (!n) return 'Nothing to download: every plan for your levels is already on this iPad.';
            return `Downloading ${n} file${n === 1 ? '' : 's'} for your levels (all in-scope levels when you have no assignment, D97).`;
          })}
        />
      </Section>

      <Section label="Storage">
        <Text style={styles.value}>
          photos {formatBytes(data?.storage.photosBytes ?? 0)} · plans {formatBytes(data?.storage.plansBytes ?? 0)} · other{' '}
          {formatBytes(data?.storage.otherBytes ?? 0)}
        </Text>
        <Btn
          label={`Free full-size photos already uploaded (${formatBytes(data?.storage.reclaimableBytes ?? 0)})`}
          disabled={!data?.storage.reclaimableBytes}
          onPress={() =>
            Alert.alert('Free photos?', 'Full-size photos the server already has are removed from this iPad and download again when opened.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Free',
                onPress: run(async () => {
                  const r = await freeUploadedPhotos(await openAppStore(), getBlobFiles());
                  await (await getBlobQueue()).refresh();
                  return `Freed ${r.files} photo${r.files === 1 ? '' : 's'} (${formatBytes(r.bytes)}).`;
                }),
              },
            ])
          }
        />
      </Section>

      <Section label="Install">
        <Text style={styles.value}>
          {identity.user.name} · app {version} ({build})
        </Text>
        <View style={styles.row}>
          <Text style={styles.value}>This iPad:</Text>
          <TextInput
            style={styles.input}
            value={label}
            placeholder={`iPad …${installId.slice(-6)}`}
            autoCorrect={false}
            maxLength={40}
            editable={!!projectId}
            onChangeText={setLabel}
            onFocus={() => setLabelFocused(true)}
            onBlur={() => {
              setLabelFocused(false);
              if (!projectId) return;
              void openAppStore()
                .then((s) => saveInstallLabel(s, projectId, identity.user.id, label))
                .then(() => load())
                .catch((e: unknown) => setNote(String(e)));
            }}
          />
        </View>
        <Text style={styles.sub}>
          Server {identity.serverUrl}
          {serverVersion ? ` (${serverVersion})` : ''} · install {installId.slice(0, 8)}
        </Text>
        <Text style={styles.sub}>
          JS {running.running} · {running.runtime}
        </Text>
        {checkLine ? <Text style={checkLine.startsWith('Could not') ? styles.warn : styles.sub}>{checkLine}</Text> : null}
        <View style={styles.row}>
          <Btn
            label="Re-sign in"
            onPress={() =>
              Alert.alert('Re-sign in?', 'You will enter the server and token again. Edits on this iPad are kept and still sync afterwards.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Re-sign in', onPress: () => void signOut() },
              ])
            }
          />
          <Btn
            label="Check for update"
            disabled={!info.enabled || updates.isChecking || updates.isDownloading}
            onPress={() => void checkAndFetch()}
          />
          <Btn
            label="Export local log"
            onPress={run(async () => {
              const f = exportLog();
              if (!f) return 'No log yet.';
              await Share.share({ url: f.uri });
            })}
          />
        </View>
      </Section>

      {note ? <Text style={styles.note}>{note}</Text> : null}
    </ScrollView>
  );
}

async function countQueuedDownloads(): Promise<number> {
  const store = await openAppStore();
  const rows = await store.db.query<{ n: number }>(
    `SELECT count(*) AS n FROM blob_queue WHERE direction = 'download' AND state IN ('queued', 'active')`,
  );
  return rows[0]?.n ?? 0;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flex: 1, gap: 6 }}>{children}</View>
    </View>
  );
}

function Btn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, disabled && { opacity: 0.4 }]} accessibilityRole="button">
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, gap: 14 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 28, fontWeight: '600' },
  link: { color: '#1f6feb', fontSize: 16 },
  hint: { color: '#555', fontSize: 14 },
  section: { flexDirection: 'row', gap: 16, borderTopWidth: 1, borderTopColor: '#e1e4e8', paddingTop: 12 },
  label: { width: 150, fontSize: 15, fontWeight: '600', color: '#333' },
  value: { fontSize: 16 },
  sub: { fontSize: 13, color: '#666' },
  warn: { fontSize: 13, color: '#b42318' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#eef1f5', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 14 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: { flex: 1, maxWidth: 260, borderWidth: 1, borderColor: '#c7c7cc', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 16 },
  btn: { alignSelf: 'flex-start', backgroundColor: '#1f6feb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  btnText: { color: 'white', fontSize: 15, fontWeight: '600' },
  note: { color: '#0a5', fontSize: 14 },
});
