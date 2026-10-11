/**
 * Photo capture and markup (T21, Phase 3 §4.4) as one full-screen modal over the plan:
 *
 * - **camera**: opens straight away (`expo-camera`); the shutter leads to the caption sheet, so a
 *   photo is two taps (shutter, Save). "Library" switches to the system picker (`expo-image-picker`).
 * - **edit**: the image with Skia markup on the left, caption fields on the right — Subject,
 *   What it shows (with phrase chips), the link (device only, or one of its punch items or
 *   connection ends), Location (from the device) — and the markup tools.
 * - **open**: an existing photo (tap a thumbnail): the same sheet, editing caption, link and markup.
 *
 * Save writes the JPEG + thumbnail (+ markup) blobs to the queue and one `photo` op; Cancel throws
 * the capture away. The original JPEG is never changed (markup is a separate stroke-list blob).
 */

import {
  emptyStrokeList,
  makeStroke,
  parseStrokeList,
  serializeStrokeList,
  uuidv7,
  withStroke,
  withoutLast,
  type BlobQueue,
  type Editor,
  type Store,
  type StrokeList,
  type StrokePoint,
} from '@field-survey/core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getBlobFiles } from '../blobs/queue';
import { prepareText, readCachedText, register } from '../blobs/store-bytes';
import { INK_COLORS } from '../ink/geometry';
import { discardPhoto, preparePhoto, type PreparedPhoto } from './capture';
import { MarkupCanvas, type MarkupTool } from './MarkupCanvas';
import {
  captionPhrases,
  createPhoto,
  loadPhoto,
  newPhotoFields,
  photoLinks,
  updatePhoto,
  type ExistingPhoto,
  type PhotoFields,
  type PhotoLink,
  type PhotoTarget,
} from './model';

export type PhotoRequest =
  | { kind: 'camera' | 'library'; target: PhotoTarget; title: string }
  | { kind: 'open'; photoId: string; title: string };

export type PhotoEnv = {
  store: Store;
  /** Null: read-only (no user yet). */
  editor: Editor | null;
  queue: Pick<BlobQueue, 'addLocal' | 'ensureLocal'>;
};

/** iOS presents a Modal in portrait unless told otherwise, and the app is landscape-only. */
const ORIENTATIONS = ['landscape-left', 'landscape-right'] as const;
const CHIPS_SHOWN = 5;

type Stage =
  | { kind: 'camera' }
  | { kind: 'busy'; text: string }
  | { kind: 'edit-new'; prepared: PreparedPhoto }
  | { kind: 'edit-existing'; photo: ExistingPhoto }
  | { kind: 'error'; text: string };

export function PhotoFlow({ request, env, onClose }: { request: PhotoRequest | null; env: PhotoEnv; onClose: (saved: boolean) => void }) {
  return (
    <Modal visible={!!request} animationType="slide" presentationStyle="fullScreen" supportedOrientations={[...ORIENTATIONS]} onRequestClose={() => onClose(false)}>
      {request ? <Flow key={request.kind === 'open' ? request.photoId : `${request.kind}-${request.title}`} request={request} env={env} onClose={onClose} /> : null}
    </Modal>
  );
}

function Flow({ request, env, onClose }: { request: PhotoRequest; env: PhotoEnv; onClose: (saved: boolean) => void }) {
  const [stage, setStage] = useState<Stage>(
    request.kind === 'camera' ? { kind: 'camera' } : { kind: 'busy', text: request.kind === 'library' ? 'Opening the library…' : 'Opening the photo…' },
  );
  const cameFromCamera = useRef(request.kind === 'camera');

  const prepare = useCallback(async (uri: string) => {
    setStage({ kind: 'busy', text: 'Converting to JPEG…' });
    try {
      const prepared = await preparePhoto(uri);
      setStage({ kind: 'edit-new', prepared });
    } catch (e) {
      console.warn('[blobs] photo not prepared', e);
      setStage({ kind: 'error', text: `The photo could not be converted: ${String((e as Error)?.message ?? e)}` });
    }
  }, []);

  const pickFromLibrary = useCallback(async () => {
    setStage({ kind: 'busy', text: 'Opening the library…' });
    try {
      const r = await launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsMultipleSelection: false });
      if (r.canceled || !r.assets[0]) {
        if (cameFromCamera.current) setStage({ kind: 'camera' });
        else onClose(false);
        return;
      }
      await prepare(r.assets[0].uri);
    } catch (e) {
      setStage({ kind: 'error', text: `The library could not be opened: ${String((e as Error)?.message ?? e)}` });
    }
  }, [prepare, onClose]);

  useEffect(() => {
    if (request.kind === 'library') void pickFromLibrary();
    if (request.kind === 'open') {
      loadPhoto(env.store, request.photoId).then(
        (photo) => setStage(photo ? { kind: 'edit-existing', photo } : { kind: 'error', text: 'This photo is not on this iPad.' }),
        (e: unknown) => setStage({ kind: 'error', text: String(e) }),
      );
    }
    // once per request: the component is keyed by it
  }, []);

  switch (stage.kind) {
    case 'camera':
      return <CameraStage title={request.title} onShot={prepare} onLibrary={pickFromLibrary} onCancel={() => onClose(false)} />;
    case 'busy':
      return (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.centerText}>{stage.text}</Text>
        </View>
      );
    case 'error':
      return (
        <View style={styles.center}>
          <Text style={styles.centerText}>{stage.text}</Text>
          <Pressable style={styles.darkBtn} onPress={() => onClose(false)}>
            <Text style={styles.darkBtnText}>Close</Text>
          </Pressable>
        </View>
      );
    case 'edit-new':
    case 'edit-existing':
      return (
        <PhotoEditor
          title={request.title}
          env={env}
          target={request.kind === 'open' ? null : request.target}
          prepared={stage.kind === 'edit-new' ? stage.prepared : null}
          existing={stage.kind === 'edit-existing' ? stage.photo : null}
          onDone={(saved) => {
            if (!saved && stage.kind === 'edit-new') discardPhoto(stage.prepared);
            onClose(saved);
          }}
        />
      );
  }
}

// ------------------------------------------------------------------ camera

function CameraStage({ title, onShot, onLibrary, onCancel }: { title: string; onShot: (uri: string) => void; onLibrary: () => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [shooting, setShooting] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const shoot = async () => {
    if (!camera.current || shooting) return;
    setShooting(true);
    try {
      const pic = await camera.current.takePictureAsync({ quality: 1, exif: false });
      onShot(pic.uri);
    } catch (e) {
      console.warn('[blobs] shutter failed', e);
      setShooting(false);
    }
  };

  if (!permission) return <View style={styles.center}><ActivityIndicator color="#fff" /></View>;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Field Survey needs the camera to take photos. Allow it in Settings, or pick from the library.</Text>
        <View style={styles.rowWrap}>
          {permission.canAskAgain ? (
            <Pressable style={styles.darkBtn} onPress={() => void requestPermission()}>
              <Text style={styles.darkBtnText}>Allow camera</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.darkBtn} onPress={() => void Linking.openSettings()}>
              <Text style={styles.darkBtnText}>Open Settings</Text>
            </Pressable>
          )}
          <Pressable style={styles.darkBtn} onPress={onLibrary}>
            <Text style={styles.darkBtnText}>🖼 Library</Text>
          </Pressable>
          <Pressable style={styles.darkBtn} onPress={onCancel}>
            <Text style={styles.darkBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.camera}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" mode="picture" onCameraReady={() => setReady(true)} />
      <View style={[styles.camTop, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onCancel} hitSlop={10}>
          <Text style={styles.camText}>✕ Cancel</Text>
        </Pressable>
        <Text style={styles.camText}>{title}</Text>
        <View style={{ width: 80 }} />
      </View>
      <View style={styles.camSide}>
        <Pressable onPress={shoot} disabled={!ready || shooting} style={[styles.shutter, (!ready || shooting) && styles.shutterBusy]} accessibilityLabel="Take photo">
          {shooting ? <ActivityIndicator color="#000" /> : null}
        </Pressable>
        <Pressable onPress={onLibrary} hitSlop={10} style={styles.camLib}>
          <Text style={styles.camText}>🖼 Library</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ editor

function PhotoEditor(props: {
  title: string;
  env: PhotoEnv;
  target: PhotoTarget | null;
  prepared: PreparedPhoto | null;
  existing: ExistingPhoto | null;
  onDone: (saved: boolean) => void;
}) {
  const { env, prepared, existing, target } = props;
  const insets = useSafeAreaInsets();
  const [fields, setFields] = useState<PhotoFields | null>(existing?.fields ?? null);
  const [links, setLinks] = useState<PhotoLink[]>([]);
  const [phrases, setPhrases] = useState<readonly string[]>([]);
  const [moreChips, setMoreChips] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(prepared ? getBlobFiles().file(prepared.image.path).uri : null);
  /** Markup needs the image the strokes are measured on; a cached thumbnail alone is view-only. */
  const [markupNote, setMarkupNote] = useState<string | null>(null);
  const [list, setList] = useState<StrokeList | null>(prepared ? emptyStrokeList('image', prepared.width, prepared.height) : null);
  const original = useRef<string | null>(null);
  const [tool, setTool] = useState<MarkupTool>('pen');
  const [color, setColor] = useState<string>(INK_COLORS[0]);
  const [textAt, setTextAt] = useState<StrokePoint | null>(null);
  const [textValue, setTextValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deviceId = existing ? existing.deviceId : (target?.deviceId ?? null);
  const readOnly = !env.editor;

  // caption defaults, link choices and chips
  useEffect(() => {
    let active = true;
    (async () => {
      const projectId = env.editor?.projectId ?? target?.projectId ?? null;
      if (!existing && target) {
        const f = await newPhotoFields(env.store, target);
        if (active) setFields(f);
      }
      const l = await photoLinks(env.store, deviceId);
      const ph = projectId ? await captionPhrases(env.store, projectId) : [];
      if (active) {
        setLinks(l);
        setPhrases(ph);
      }
    })().catch((e: unknown) => console.warn('[store] photo sheet', e));
    return () => {
      active = false;
    };
  }, [env.store, env.editor, existing, target, deviceId]);

  // an existing photo: full image (on demand), its markup, else the thumbnail
  useEffect(() => {
    if (!existing) return;
    let active = true;
    (async () => {
      const files = getBlobFiles();
      let uri: string | null = null;
      let full = false;
      if (existing.image && !existing.thumbOnly) {
        const path = await env.queue.ensureLocal(existing.image, 'image');
        if (path) {
          uri = files.file(path).uri;
          full = true;
        }
      }
      if (!uri && existing.thumb) {
        const path = await env.queue.ensureLocal(existing.thumb, 'thumb');
        if (path) uri = files.file(path).uri;
      }
      if (!active) return;
      setImageUri(uri);
      let markup: StrokeList | null = null;
      if (existing.markup) {
        const text = await readCachedText(env.queue, existing.markup, 'markup');
        if (text) {
          try {
            markup = parseStrokeList(text);
            original.current = serializeStrokeList(markup);
          } catch (e) {
            console.warn('[blobs] markup unreadable', e);
          }
        }
        if (!markup && active) setMarkupNote('The markup is not downloaded yet; connect to see or change it.');
      }
      if (!markup && uri && (full || existing.thumbOnly) && !existing.markup) {
        const size = await new Promise<{ width: number; height: number }>((res, rej) => Image.getSize(uri!, (width, height) => res({ width, height }), rej));
        markup = emptyStrokeList('image', size.width, size.height);
        original.current = serializeStrokeList(markup);
      } else if (!full && !existing.thumbOnly && !markup && active) {
        setMarkupNote('The full image is not on this iPad; markup needs it (connect and reopen).');
      }
      if (active) setList(markup);
    })().catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [existing, env.queue]);

  const save = async () => {
    if (!env.editor || !fields) return;
    setSaving(true);
    setError(null);
    try {
      let markupSha: string | null = existing?.markup ?? null;
      const changed = list ? serializeStrokeList(list) !== original.current : false;
      if (list && (changed || prepared)) {
        if (list.strokes.length) {
          const m = await prepareText(serializeStrokeList(list), 'markup');
          await register(env.queue, m);
          markupSha = m.sha256;
        } else {
          markupSha = null;
        }
      }
      if (prepared && target) {
        // bytes first (thumbnail is sent first by the queue), then the record
        await register(env.queue, prepared.image);
        await register(env.queue, prepared.thumb);
        await createPhoto(env.editor, {
          target,
          fields,
          image: prepared.image,
          thumb: prepared.thumb,
          markupSha,
          takenAt: new Date().toISOString(),
        });
      } else if (existing) {
        await updatePhoto(env.editor, existing.id, fields, markupSha);
      }
      props.onDone(true);
    } catch (e) {
      console.warn('[store] photo not saved', e);
      setError(`Not saved: ${String((e as Error)?.message ?? e)}`);
      setSaving(false);
    }
  };

  const placeText = () => {
    if (!list || !textAt || !textValue.trim()) return;
    const size = Math.max(list.width, list.height) / 30;
    setList(withStroke(list, makeStroke({ id: uuidv7(), tool: 'text', color, width: size, points: [textAt], text: textValue, at: new Date().toISOString() })));
    setTextAt(null);
    setTextValue('');
  };

  const set = (patch: Partial<PhotoFields>) => setFields((f) => (f ? { ...f, ...patch } : f));
  const linkKey = fields?.punchItemId ? `punch:${fields.punchItemId}` : fields?.cableEndId ? `end:${fields.cableEndId}` : 'none';
  const chips = moreChips ? phrases : phrases.slice(0, CHIPS_SHOWN);
  const lineWidth = list ? Math.max(list.width, list.height) / 250 : 4;

  return (
    <View style={styles.editor}>
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => props.onDone(false)} hitSlop={8} disabled={saving}>
          <Text style={styles.headLink}>◀ {existing ? 'Close' : 'Cancel'}</Text>
        </Pressable>
        <Text style={styles.headTitle} numberOfLines={1}>
          {props.title} · Photo {existing ? (existing.isNew ? 'NEW' : existing.label) : 'NEW'}
        </Text>
        {readOnly ? (
          <View style={{ width: 60 }} />
        ) : (
          <Pressable onPress={save} disabled={saving || !fields} style={[styles.saveBtn, (saving || !fields) && styles.saveBusy]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.imageArea}>
          {list ? (
            <MarkupCanvas
              imageUri={imageUri}
              list={list}
              onChange={setList}
              tool={tool}
              color={color}
              lineWidth={lineWidth}
              onTextAt={(p) => setTextAt(p)}
              readOnly={readOnly}
            />
          ) : imageUri ? (
            <Image source={{ uri: imageUri }} style={styles.flex} resizeMode="contain" />
          ) : (
            <View style={styles.center}>
              <Text style={styles.centerText}>The image is not on this iPad yet.</Text>
            </View>
          )}
        </View>
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelBody} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {fields ? (
            <>
              <Text style={styles.label}>Subject</Text>
              <TextInput style={styles.input} value={fields.subject ?? ''} onChangeText={(t) => set({ subject: t })} placeholder="e.g. ERP interior" placeholderTextColor="#888" editable={!readOnly} />
              <Text style={styles.label}>What it shows</Text>
              <TextInput
                style={[styles.input, styles.multi]}
                value={fields.whatItShows ?? ''}
                onChangeText={(t) => set({ whatItShows: t })}
                placeholder="Caption"
                placeholderTextColor="#888"
                multiline
                editable={!readOnly}
              />
              {readOnly ? null : (
                <View style={styles.rowWrap}>
                  {chips.map((p) => (
                    <Pressable key={p} style={styles.phrase} onPress={() => set({ whatItShows: fields.whatItShows?.trim() ? `${fields.whatItShows.trim()}; ${p}` : p })}>
                      <Text style={styles.phraseText} numberOfLines={1}>{p}</Text>
                    </Pressable>
                  ))}
                  {phrases.length > CHIPS_SHOWN ? (
                    <Pressable style={styles.phrase} onPress={() => setMoreChips((m) => !m)}>
                      <Text style={styles.phraseMore}>{moreChips ? 'less ▴' : `more (${phrases.length - CHIPS_SHOWN}) ▾`}</Text>
                    </Pressable>
                  ) : null}
                </View>
              )}
              <Text style={styles.label}>Linked</Text>
              <Text style={styles.muted}>{deviceId ? props.title : 'Level only (no device)'}</Text>
              {links.length ? (
                <View style={styles.rowWrap}>
                  <LinkChip label="Device only" on={linkKey === 'none'} disabled={readOnly} onPress={() => set({ punchItemId: null, cableEndId: null })} />
                  {links.map((l) => (
                    <LinkChip
                      key={l.id}
                      label={l.label}
                      on={linkKey === `${l.kind}:${l.id}`}
                      disabled={readOnly}
                      onPress={() => set(l.kind === 'punch' ? { punchItemId: l.id, cableEndId: null } : { cableEndId: l.id, punchItemId: null })}
                    />
                  ))}
                </View>
              ) : null}
              <Text style={styles.label}>Location</Text>
              <TextInput style={styles.input} value={fields.location ?? ''} onChangeText={(t) => set({ location: t })} placeholder="Room / location" placeholderTextColor="#888" editable={!readOnly} />
            </>
          ) : (
            <ActivityIndicator />
          )}

          <Text style={styles.label}>Markup</Text>
          {markupNote ? <Text style={styles.muted}>{markupNote}</Text> : null}
          {list && !readOnly ? (
            <>
              <View style={styles.rowWrap}>
                {(
                  [
                    ['pen', '✎ Pen'],
                    ['ellipse', '○ Circle'],
                    ['arrow', '→ Arrow'],
                    ['text', 'T Text'],
                    ['erase', '⌫ Erase'],
                  ] as [MarkupTool, string][]
                ).map(([k, label]) => (
                  <LinkChip key={k} label={label} on={tool === k} onPress={() => (setTool(k), setTextAt(null))} />
                ))}
                <LinkChip label="↶ Undo" on={false} disabled={!list.strokes.length} onPress={() => setList(withoutLast(list))} />
              </View>
              <View style={styles.rowWrap}>
                {INK_COLORS.map((c) => (
                  <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchOn]} accessibilityLabel={`Colour ${c}`} />
                ))}
              </View>
              {tool === 'text' ? (
                textAt ? (
                  <View style={styles.rowWrap}>
                    <TextInput style={[styles.input, styles.flex]} value={textValue} onChangeText={setTextValue} placeholder="Text to place" placeholderTextColor="#888" autoFocus onSubmitEditing={placeText} returnKeyType="done" />
                    <LinkChip label="Place" on={false} disabled={!textValue.trim()} onPress={placeText} />
                  </View>
                ) : (
                  <Text style={styles.muted}>Tap the photo where the text goes.</Text>
                )
              ) : null}
              <Text style={styles.muted}>Original kept; markup saved separately.</Text>
            </>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

function LinkChip({ label, on, onPress, disabled }: { label: string; on: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.chip, on && styles.chipOn, disabled && styles.chipDisabled]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, backgroundColor: '#1d1f22' },
  centerText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  darkBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#3a3d42' },
  darkBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  camera: { flex: 1, backgroundColor: '#000' },
  camTop: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 10, backgroundColor: 'rgba(0,0,0,0.35)' },
  camText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  camSide: { position: 'absolute', right: 28, top: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', gap: 28 },
  shutter: { width: 78, height: 78, borderRadius: 39, backgroundColor: '#fff', borderWidth: 6, borderColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center' },
  shutterBusy: { opacity: 0.6 },
  camLib: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.45)' },
  editor: { flex: 1, backgroundColor: '#f4f5f7' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingBottom: 10, backgroundColor: '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  headLink: { fontSize: 17, color: '#1565c0', fontWeight: '600' },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  saveBtn: { minWidth: 70, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1565c0' },
  saveBusy: { opacity: 0.6 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  body: { flex: 1, flexDirection: 'row' },
  imageArea: { flex: 68, backgroundColor: '#1d1f22' },
  panel: { flex: 32, backgroundColor: '#fff', borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#c9ccd1' },
  panelBody: { padding: 14, gap: 8, paddingBottom: 40 },
  label: { fontSize: 13, fontWeight: '700', color: '#333', marginTop: 6 },
  input: { borderWidth: 1, borderColor: '#c9ccd1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 7, fontSize: 15, backgroundColor: '#fff' },
  multi: { minHeight: 64, textAlignVertical: 'top' },
  muted: { fontSize: 12, color: '#777' },
  error: { color: '#b71c1c', fontSize: 13 },
  phrase: { maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 12, backgroundColor: '#eef2f7' },
  phraseText: { fontSize: 12, color: '#1f3b63' },
  phraseMore: { fontSize: 12, color: '#1565c0', fontWeight: '600' },
  chip: { maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#c9ccd1', backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#1565c0', borderColor: '#1565c0' },
  chipDisabled: { opacity: 0.45 },
  chipText: { fontSize: 13, color: '#222' },
  chipTextOn: { color: '#fff', fontWeight: '600' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: '#999' },
  swatchOn: { borderWidth: 3, borderColor: '#00bcd4' },
});
