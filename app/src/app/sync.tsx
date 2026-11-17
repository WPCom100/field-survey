import Constants from 'expo-constants';
import { router } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { getBlobFiles, getBlobQueue } from '../blobs/queue';
import { useBlobStatus } from '../blobs/useBlobStatus';
import { openAppStore } from '../db';
import { pickProject } from '../home/currentProject';
import { levelName, listProjects } from '../home/data';
import { SectionScreen } from '../home/SectionScreen';
import { useIdentity, useMicrosoftSignIn, useSignOut } from '../identity/IdentityGate';
import { fetchAuthConfig, SignInCancelled } from '../identity/microsoft';
import { SIGN_IN_NEEDED } from '../identity/session';
import { exportLog } from '../log';
import { lastRulesPass } from '../rules/engine';
import { getSyncEngine } from '../sync/engine';
import { loadInstallLabels, saveInstallLabel } from '../sync/install';
import {
  connectionTile,
  describeCycle,
  editsTileSub,
  formatBytes,
  freeUploadedPhotos,
  levelBytesLine,
  levelsCaption,
  levelStateLabel,
  loadServerVersion,
  loadSyncScreen,
  photosTileSub,
  retryFailedUploads,
  stamp,
  storageShares,
  unknownUserNotice,
  type CachedLevel,
  type SyncScreenData,
  type TileTone,
} from '../sync/screen';
import { checkAndFetch, runningInfo, useUpdateCheckState } from '../sync/useAppUpdates';
import { describeCheck, describeRunning } from '../sync/updates';
import { useSyncStatus } from '../sync/useSyncStatus';
import { Banner, Btn, Card, color, font, hit, Icon, radius, Section, space, tabular, type BannerTone } from '../ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const TONE: Record<TileTone, string> = { text: color.text, success: color.success, warning: color.warning, danger: color.danger };
/** Two columns (Levels left; account, storage, Details right) from this content width; one below it (portrait). */
const TWO_COLUMNS = 900;
/**
 * VoiceOver label of the screen's Re-sign in buttons. Flows tap the confirm alert's "Re-sign in"
 * by text (`rightOf: Cancel`); with the board's layout these buttons sit right of the alert too,
 * so they must not answer to the same text.
 */
const RESIGN_LABEL = 'Re-sign in on this iPad';

/**
 * Sync & uploads (T25, Phase 3 §12; the "Sync · Details" board since T178): Sync now, the four
 * tiles, the levels on this iPad, the account, storage and a Details disclosure for support. Sync
 * and uploads use any network, cellular included (D121).
 */
export default function SyncScreen() {
  const identity = useIdentity();
  const signOut = useSignOut();
  const microsoftSignIn = useMicrosoftSignIn();
  const sync = useSyncStatus();
  // Does this server offer Microsoft sign-in (T04, D265)? Asked so a team-picker iPad can move over.
  const [offersMicrosoft, setOffersMicrosoft] = useState(false);
  const blobs = useBlobStatus();
  const [data, setData] = useState<SyncScreenData | null>(null);
  const [installId, setInstallId] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [labelFocused, setLabelFocused] = useState(false);
  const [hasProject, setHasProject] = useState<boolean | null>(null);
  const [note, setNote] = useState<{ text: string; tone: BannerTone } | null>(null);
  const [serverVersion, setServerVersion] = useState('');
  // null: folded, unless edits were refused (then the list is what the screen is for)
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const [width, setWidth] = useState(0);
  const [tileCols, setTileCols] = useState(4);
  const updates = useUpdateCheckState();
  const info = runningInfo();
  const running = describeRunning(info);
  const checkLine = describeCheck(updates);

  const load = useCallback(async () => {
    const store = await openAppStore();
    // the project the home shows (T83), not the first on the iPad: with several projects these
    // were another project's counts (T156: "0" pending under a status bar reading "22 pending")
    const projects = await listProjects(store);
    const current = pickProject(projects.map((p) => p.id));
    const project = projects.find((p) => p.id === current);
    setInstallId(store.installId);
    setProjectId(project?.id ?? null);
    if (!labelFocused) setLabel((await loadInstallLabels(store)).get(store.installId) ?? '');
    setHasProject(!!project);
    setData(await loadSyncScreen(store, project?.id ?? null, identity.user.id));
  }, [labelFocused, identity.user.id]);

  useEffect(() => {
    load().catch((e: unknown) => setNote({ text: String(e), tone: 'danger' }));
  }, [load, sync.lastSyncAt, sync.pendingOps, blobs.photosWaiting, blobs.uploadsFailed, blobs.downloadsPending, blobs.cacheBytes]);

  // Re-read when sync state changes, so a deploy shows up once the iPad is online again.
  useEffect(() => {
    void loadServerVersion(identity.serverUrl).then(setServerVersion);
  }, [identity.serverUrl, sync.lastSyncAt, sync.state]);

  useEffect(() => {
    fetchAuthConfig(identity.serverUrl).then(
      (c) => setOffersMicrosoft(!!c.entra),
      () => {}, // offline: keep what was known
    );
  }, [identity.serverUrl, sync.state]);

  const run = (fn: () => Promise<string | void>) => () =>
    fn().then(
      (m) => {
        if (m) setNote({ text: m, tone: 'success' });
        return load();
      },
      (e: unknown) => setNote({ text: String(e), tone: 'danger' }),
    );

  const seq = Object.values(sync.lastServerSeq).reduce((a, b) => Math.max(a, b), 0);
  const build = Constants.platform?.ios?.buildNumber ?? '—';
  const version = Constants.expoConfig?.version ?? '—';
  const signedInMicrosoft = !!identity.microsoft;
  const refused = data?.outbox.quarantined ?? [];
  const stranger = data ? unknownUserNotice(refused, identity.user, signedInMicrosoft) : null;
  const needsSignIn = sync.state === 'error' && sync.lastFailure === 'auth';
  const canMicrosoft = signedInMicrosoft || offersMicrosoft;
  const showDetails = detailsOpen ?? refused.length > 0;
  const conn = connectionTile(sync, seq);
  const pending = data?.outbox.pending ?? sync.pendingOps;

  const confirmResign = () =>
    Alert.alert(
      'Re-sign in?',
      signedInMicrosoft
        ? 'You will enter the server again and sign in (with Microsoft or a token). Edits on this iPad are kept and still sync afterwards.'
        : 'You will enter the server and token again. Edits on this iPad are kept and still sync afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Re-sign in', onPress: () => void signOut() },
      ],
    );
  // Interactive Microsoft sign-in (T04): the sync engine restarts with the new session at once.
  const signInMicrosoft = run(async () => {
    try {
      await microsoftSignIn();
      return 'Signed in with Microsoft.';
    } catch (e) {
      if (e instanceof SignInCancelled) return;
      throw e;
    }
  });
  const syncNow = run(async () => {
    await (await getSyncEngine()).requestSync();
  });
  const retryRefused = run(async () => {
    const n = await (await getSyncEngine()).retryQuarantined();
    return `${plural(n, 'edit')} sent again.`;
  });
  const retryUploads = run(async () => {
    const n = await retryFailedUploads(await openAppStore());
    await (await getBlobQueue()).requestRun();
    return `${plural(n, 'upload')} queued again.`;
  });
  const downloadAssigned = run(async () => {
    const q = await getBlobQueue();
    await q.prefetch();
    const n = await countQueuedDownloads();
    await q.requestRun();
    if (!n) return 'Nothing to download: every plan for your levels is already on this iPad.';
    return `Downloading ${plural(n, 'file')} for your levels (all in-scope levels when you have no assignment, D97).`;
  });
  const freePhotos = () =>
    Alert.alert('Free photos?', 'Full-size photos the server already has are removed from this iPad and download again when opened.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Free',
        onPress: run(async () => {
          const r = await freeUploadedPhotos(await openAppStore(), getBlobFiles());
          await (await getBlobQueue()).refresh();
          return `Freed ${plural(r.files, 'photo')} (${formatBytes(r.bytes)}).`;
        }),
      },
    ]);
  const saveLabel = () => {
    setLabelFocused(false);
    if (!projectId) return;
    void openAppStore()
      .then((s) => saveInstallLabel(s, projectId, identity.user.id, label))
      .then(() => load())
      .catch((e: unknown) => setNote({ text: String(e), tone: 'danger' }));
  };

  // ---------------------------------------------------------------- the cards

  const account = (
    <Card style={styles.gap8}>
      <View style={styles.accountHead}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(identity.user.name.trim()[0] ?? '?').toUpperCase()}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.sec}>{identity.user.name}</Text>
          <Text style={styles.caption} testID="sync.account">
            {signedInMicrosoft
              ? `Signed in with Microsoft${identity.microsoft?.email ? ` · ${identity.microsoft.email}` : ''}`
              : 'Team picker with the shared token'}
          </Text>
        </View>
        <Btn kind="tertiary" title="Re-sign in" testID="sync.resign" accessibilityLabel={RESIGN_LABEL} onPress={confirmResign} />
      </View>
      {offersMicrosoft && !signedInMicrosoft ? (
        <Btn title="Sign in with Microsoft" testID="sync.microsoft" onPress={signInMicrosoft} />
      ) : null}
      <View style={styles.labelRow}>
        <Text style={styles.labelKey}>This iPad</Text>
        <TextInput
          style={[styles.input, !projectId && styles.inputOff]}
          value={label}
          placeholder={`iPad …${installId.slice(-6)}`}
          placeholderTextColor={color.text3}
          autoCorrect={false}
          maxLength={40}
          editable={!!projectId}
          onChangeText={setLabel}
          onFocus={() => setLabelFocused(true)}
          onBlur={saveLabel}
          testID="sync.label"
        />
        <Text style={[styles.caption, styles.flex]}>How Needs review names this iPad.</Text>
      </View>
    </Card>
  );

  const levels = data?.levels ?? [];
  const levelsCard = (
    <Card flush>
      <View style={styles.cardHead}>
        <Text style={styles.sec}>Levels on this iPad</Text>
        <Text style={styles.caption}>{levelsCaption(levels)}</Text>
      </View>
      {levels.map((l) => (
        <LevelRow key={l.id} level={l} />
      ))}
      {data && !levels.length ? (
        <Text style={[styles.caption, styles.rowPad]}>
          {hasProject ? 'This project has no levels yet.' : 'No levels on this iPad yet (a project arrives with setup).'}
        </Text>
      ) : null}
      <View style={[styles.lr, styles.footer]}>
        <Text style={[styles.caption, styles.flex]}>Plans of your levels; every in-scope level when none is assigned to you.</Text>
        <Btn kind="tertiary" title="Download assigned levels" disabled={data ? !levels.some((l) => l.cache !== 'no sheet') : false} onPress={downloadAssigned} />
      </View>
    </Card>
  );

  const shares = storageShares(data?.storage ?? { photosBytes: 0, plansBytes: 0, otherBytes: 0, reclaimableBytes: 0 });
  const storage = data?.storage;
  const storageCard = (
    <Card style={styles.gap8}>
      <View style={styles.headRow}>
        <Text style={styles.sec}>Storage</Text>
        <Text style={styles.caption}>{formatBytes(shares.total)} on this iPad</Text>
      </View>
      <View
        style={styles.bar}
        accessible
        accessibilityLabel={`Plans ${formatBytes(storage?.plansBytes ?? 0)}, photos ${formatBytes(storage?.photosBytes ?? 0)}, other ${formatBytes(storage?.otherBytes ?? 0)}`}
      >
        <View style={{ flex: shares.plans, backgroundColor: color.primary }} />
        <View style={{ flex: shares.photos, backgroundColor: color.text3 }} />
        <View style={{ flex: shares.other, backgroundColor: color.border }} />
      </View>
      <View style={styles.legend}>
        <Key fill={color.primary} text={`Plans ${formatBytes(storage?.plansBytes ?? 0)}`} />
        <Key fill={color.text3} text={`Photos ${formatBytes(storage?.photosBytes ?? 0)}`} />
        <Key fill={color.border} text={`Other ${formatBytes(storage?.otherBytes ?? 0)}`} />
        <View style={styles.flex} />
        <Btn kind="tertiary" small title={`Free uploaded photos (${formatBytes(storage?.reclaimableBytes ?? 0)})`} disabled={!storage?.reclaimableBytes} onPress={freePhotos} />
      </View>
    </Card>
  );

  const detailsCard = (
    <Card flush>
      <Section
        title="Details"
        open={showDetails}
        onToggle={setDetailsOpen}
        right={<Text style={styles.caption}>For support</Text>}
        testID="sync.details"
      >
        <View style={styles.details}>
          <Detail k="Server">
            {identity.serverUrl}
            {serverVersion ? ` · ${serverVersion}` : ''}
          </Detail>
          <Detail k="This iPad">{[installId.slice(0, 8), identity.user.name, label.trim() || null].filter(Boolean).join(' · ')}</Detail>
          <Detail k="App">
            {version} ({build}) · JS {running.running} · {running.runtime}
          </Detail>
          <Detail k="Update" tone={checkLine?.startsWith('Could not') ? 'danger' : undefined}>
            {checkLine ?? 'Not checked since the app started'}
          </Detail>
          <Detail k="Last cycle" testID="sync.timing">
            {describeCycle(sync.lastCycle, lastRulesPass())}
          </Detail>
          {blobs.lastError ? <Detail k="Photo queue">Last error: {blobs.lastError}</Detail> : null}
          <Detail k="Refused edits" tone={refused.length ? 'danger' : 'muted'}>
            {refused.length ? `${plural(refused.length, 'edit')} the server refused` : 'None'}
          </Detail>
          {refused.map((q) => (
            <Text key={q.opId} style={styles.refused} testID="sync.refused">
              {q.what} · {stamp(q.at)} · {q.attempts} {q.attempts === 1 ? 'try' : 'tries'}: {q.error ?? 'unknown error'}
            </Text>
          ))}
          <View style={styles.detailActions}>
            <Btn
              title="Export log"
              icon={<Icon name="export" size={18} color={color.text} />}
              onPress={run(async () => {
                const f = exportLog();
                if (!f) return 'No log yet.';
                await Share.share({ url: f.uri });
              })}
            />
            <Btn title="Check for update" disabled={!info.enabled || updates.isChecking || updates.isDownloading} onPress={() => void checkAndFetch()} />
            <Btn kind="tertiary" title="Retry refused edits" testID="sync.retryRefused" disabled={!refused.length} onPress={retryRefused} />
          </View>
        </View>
      </Section>
    </Card>
  );

  const failedUploads = data?.failedUploads ?? [];
  const firstFailed = failedUploads[0];

  return (
    <SectionScreen
      section="Sync"
      projectId={projectId}
      title="Sync & uploads"
      intro="Edits never need sign-in or a connection. Sync, uploads and exports do, on any network, cellular included."
      backTestID="sync.back"
      actions={<Btn kind="primary" title="Sync now" testID="sync.now" icon={<Icon name="sync" size={18} color={color.onPrimary} />} onPress={syncNow} />}
    >
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.inner} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>

        {needsSignIn ? (
          <Banner
            tone="warning"
            testID="sync.signInNeeded"
            text={`${SIGN_IN_NEEDED}. ${
              signedInMicrosoft
                ? 'Your Microsoft sign-in has run out or was refused. Edits are kept on this iPad and sync once you sign in again.'
                : canMicrosoft
                  ? 'The server no longer takes the team token. Sign in with Microsoft; edits on this iPad are kept and sync afterwards.'
                  : "The server refused this iPad's token. Re-sign in with the current token; edits on this iPad are kept."
            }`}
            action={
              canMicrosoft
                ? { label: 'Sign in with Microsoft', onPress: signInMicrosoft, testID: 'sync.signInNeeded.microsoft' }
                : { label: 'Re-sign in', onPress: confirmResign, testID: 'sync.signInNeeded.resign', accessibilityLabel: RESIGN_LABEL }
            }
          />
        ) : null}
        {refused.length ? (
          <Banner
            tone="danger"
            text={`${plural(refused.length, 'edit')} the server refused. The other edits keep syncing; these wait under Details until Retry refused edits.`}
          />
        ) : null}
        {/* the notice and its button before the rows: a lost user refuses hundreds of edits (T160) */}
        {stranger ? (
          <Banner
            tone="danger"
            testID="sync.unknownUser"
            text={stranger}
            action={
              signedInMicrosoft
                ? { label: 'Sign in with Microsoft', onPress: signInMicrosoft, testID: 'sync.unknownUser.microsoft' }
                : { label: 'Re-sign in', onPress: confirmResign, testID: 'sync.unknownUser.resign', accessibilityLabel: RESIGN_LABEL }
            }
          />
        ) : null}
        {data?.outbox.failing ? (
          <Banner tone="warning" text={`${plural(data.outbox.failing, 'edit')} failed to send: ${data.outbox.lastError ?? 'unknown error'}`} />
        ) : null}
        {firstFailed ? (
          <Banner
            tone="danger"
            text={`Upload failed (${firstFailed.kind}, ${firstFailed.attempts} tries): ${firstFailed.error ?? 'unknown'}${
              failedUploads.length > 1 ? ` · ${failedUploads.length - 1} more` : ''
            }`}
            action={{ label: 'Retry failed uploads', onPress: retryUploads, testID: 'sync.retryUploads' }}
          />
        ) : null}
        {hasProject === false ? (
          <Banner text={'No project on this iPad yet, so there is nothing to push or pull; "Synced" means the server answered. The demo plan never syncs.'} />
        ) : null}
        {note ? <Banner tone={note.tone} text={note.text} testID="sync.note" /> : null}

        <View style={styles.tiles} onLayout={(e) => setTileCols(e.nativeEvent.layout.width >= 4 * 160 + 3 * space.lg ? 4 : 2)}>
          <Tile label="Connection" cols={tileCols} sub={conn.sub} testID="sync.tile.connection">
            <View style={styles.connValue}>
              {conn.icon ? <Icon name={conn.icon} size={22} color={TONE[conn.tone]} strokeWidth={conn.icon === 'check' ? 2.4 : 2} /> : null}
              <Text style={[styles.connText, { color: TONE[conn.tone] }]} numberOfLines={1}>
                {conn.value}
              </Text>
            </View>
          </Tile>
          <Tile label="Edits waiting" cols={tileCols} sub={editsTileSub(data?.outbox.oldestAt ?? null)} testID="sync.tile.edits">
            <Text style={[styles.tileValue, pending > 0 && { color: color.warning }]} testID="sync.pending">
              {pending}
            </Text>
          </Tile>
          <Tile label="Photos waiting" cols={tileCols} sub={photosTileSub(blobs)} testID="sync.tile.photos">
            <Text style={[styles.tileValue, blobs.photosWaiting > 0 && { color: color.warning }]} testID="sync.photos">
              {blobs.photosWaiting}
            </Text>
          </Tile>
          <Tile label="Needs review" cols={tileCols} testID="sync.tile.review">
            <Text style={[styles.tileValue, (data?.openReviews ?? 0) > 0 && { color: color.warning }]}>{data?.openReviews ?? 0}</Text>
            {sync.willReview ? <Text style={styles.caption}>{sync.willReview} of my pending edits will be reviewed</Text> : null}
            <Pressable onPress={() => router.push('/review')} accessibilityRole="link" testID="sync.review" hitSlop={space.sm}>
              <Text style={styles.link}>Open Needs review</Text>
            </Pressable>
          </Tile>
        </View>

        {width >= TWO_COLUMNS ? (
          <View style={styles.cols}>
            <View style={styles.col}>{levelsCard}</View>
            <View style={styles.col}>
              {account}
              {storageCard}
              {detailsCard}
            </View>
          </View>
        ) : (
          // one column (portrait): the account first, so Re-sign in is on screen without a scroll
          <>
            {account}
            {levelsCard}
            {storageCard}
            {detailsCard}
          </>
        )}
      </View>
    </ScrollView>
    </SectionScreen>
  );
}

async function countQueuedDownloads(): Promise<number> {
  const store = await openAppStore();
  const rows = await store.db.query<{ n: number }>(
    `SELECT count(*) AS n FROM blob_queue WHERE direction = 'download' AND state IN ('queued', 'active')`,
  );
  return rows[0]?.n ?? 0;
}

function Tile({ label, sub, cols, children, testID }: { label: string; sub?: string; cols: number; children: ReactNode; testID: string }) {
  return (
    <View style={[styles.tile, { width: cols === 4 ? '21%' : '46%' }]} testID={testID}>
      <Text style={styles.tileLabel}>{label}</Text>
      {children}
      {sub ? <Text style={styles.caption}>{sub}</Text> : null}
    </View>
  );
}

const STATE_ICON: Record<CachedLevel['cache'], 'check' | 'download' | null> = { cached: 'check', downloading: 'download', 'not cached': null, 'no sheet': null };

function LevelRow({ level: l }: { level: CachedLevel }) {
  const name = [levelName(l.code), l.assignedToMe ? 'assigned to me' : null, l.inScope ? null : 'out of scope'].filter(Boolean).join(' · ');
  const bytes = levelBytesLine(l);
  const total = l.planBytes + l.photoBytes;
  const icon = STATE_ICON[l.cache];
  const on = l.cache === 'cached' || l.cache === 'downloading';
  return (
    <View style={[styles.lr, !l.inScope && styles.outOfScope]}>
      <Text style={styles.lrCode}>{l.code}</Text>
      <View style={styles.flex}>
        {name ? <Text style={styles.lrName}>{name}</Text> : null}
        {bytes ? <Text style={styles.caption}>{bytes}</Text> : null}
      </View>
      <Text style={[styles.caption, tabular, styles.lrSize]}>{total ? formatBytes(total) : '–'}</Text>
      <View style={styles.lrState}>
        {icon ? <Icon name={icon} size={16} color={color.text2} strokeWidth={icon === 'check' ? 2.2 : 2} /> : null}
        <Text style={[styles.lrStateText, !on && { color: color.text3 }]} testID={`sync.level.${l.code}`}>
          {levelStateLabel(l.cache)}
        </Text>
      </View>
    </View>
  );
}

function Detail({ k, children, tone, testID }: { k: string; children: ReactNode; tone?: 'danger' | 'muted'; testID?: string }) {
  return (
    <View style={styles.dr}>
      <Text style={styles.dk}>{k}</Text>
      <Text style={[styles.dv, tone === 'danger' && { color: color.danger }, tone === 'muted' && { color: color.text3 }]} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

function Key({ fill, text }: { fill: string; text: string }) {
  return (
    <View style={styles.key}>
      <View style={[styles.dot, { backgroundColor: fill }]} />
      <Text style={styles.keyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.xxl },
  inner: { gap: 20 },
  flex: { flex: 1 },
  gap8: { gap: space.sm },
  caption: { ...font.caption, color: color.text3 },
  sec: { ...font.headline, color: color.text },
  link: { ...font.captionBold, color: color.primary },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  tile: {
    flexGrow: 1,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingVertical: space.lg,
    paddingHorizontal: 20,
    gap: 2,
  },
  tileLabel: { ...font.caption, color: color.text2 },
  tileValue: { ...font.display, ...tabular, color: color.text },
  connValue: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 34 },
  connText: { ...font.title, flexShrink: 1 },
  cols: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start' },
  col: { flex: 1, gap: space.lg },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, minHeight: 52, paddingHorizontal: 20 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, minHeight: 32 },
  rowPad: { paddingHorizontal: 20, paddingBottom: space.md },
  lr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: 20,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  footer: { minHeight: hit.target + space.sm },
  outOfScope: { opacity: 0.55 },
  lrCode: { ...font.headline, color: color.text, width: 56 },
  lrName: { ...font.callout, color: color.text2 },
  lrSize: { minWidth: 64, textAlign: 'right' },
  lrState: { width: 120, flexDirection: 'row', alignItems: 'center', gap: 6 },
  lrStateText: { ...font.caption, color: color.text2 },
  accountHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: { width: 32, height: 32, borderRadius: radius.pill, backgroundColor: color.border, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...font.calloutBold, color: color.text },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
    paddingTop: space.sm,
  },
  labelKey: { ...font.callout, color: color.text2 },
  input: {
    width: 200,
    height: hit.control,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.control,
    backgroundColor: color.surface,
    ...font.callout,
    color: color.text,
  },
  inputOff: { backgroundColor: color.surface2, color: color.text3 },
  bar: { flexDirection: 'row', height: 12, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: color.surface2, marginTop: space.xs },
  legend: { flexDirection: 'row', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' },
  key: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  keyText: { ...font.caption, color: color.text2 },
  details: { paddingLeft: 26 + space.lg, paddingRight: 20, paddingBottom: space.lg, paddingTop: space.xs, gap: 2 },
  dr: { flexDirection: 'row', gap: space.md, minHeight: 26, alignItems: 'flex-start', paddingVertical: space.xs },
  dk: { ...font.caption, color: color.text2, width: 110 },
  dv: { ...font.caption, ...tabular, color: color.text, flex: 1 },
  refused: { ...font.caption, color: color.danger, paddingLeft: 110 + space.md, paddingVertical: 2 },
  detailActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: 10 },
});
