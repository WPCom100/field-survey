import { HttpClient } from '@field-survey/core';
import { File, Paths } from 'expo-file-system';
import { Share } from 'react-native';

import { openAppStore } from '../db';
import type { Identity } from '../identity/api';
import { downloadedExports, rememberDownload, shareName, type ExportRow } from './model';

/**
 * Finished export files on the iPad (T31, D140): `Documents/exports/<export id>/<filename>`,
 * downloaded once from `GET /exports/{id}/file` and kept (Documents, so iOS does not purge them),
 * so a file exported earlier still opens with no connection, labelled with its export time
 * (D94). Paths are stored relative to Documents (the container moves on app updates).
 */
const DIR = 'exports';

function fileFor(path: string): File {
  return new File(Paths.document, path);
}

/** The local copy of an export, or null when it was never downloaded (or has gone). */
export async function localExport(e: ExportRow): Promise<File | null> {
  const store = await openAppStore();
  const path = (await downloadedExports(store))[e.id];
  if (!path) return null;
  const f = fileFor(path);
  return f.exists ? f : null;
}

/** Download the finished file (once) and return it. Needs a connection the first time. */
export async function ensureExportFile(identity: Identity, e: ExportRow): Promise<File> {
  const have = await localExport(e);
  if (have) return have;
  if (e.job_state !== 'done') throw new Error('The export has not finished.');
  const rel = `${DIR}/${e.id}/${shareName(e)}`;
  const dest = fileFor(rel);
  const parent = dest.parentDirectory;
  if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
  const http = new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name });
  await File.downloadFileAsync(http.url(`/exports/${e.id}/file`), dest, { headers: http.headers(), idempotent: true });
  await rememberDownload(await openAppStore(), e.id, rel);
  return dest;
}

/**
 * The iOS share sheet for the file: Open in Excel (or Numbers, Acrobat…), Save to Files, AirDrop,
 * Mail. React Native's built-in `Share` takes a file URL on iOS, so no `expo-sharing` (D140).
 */
export async function shareExportFile(file: File): Promise<void> {
  await Share.share({ url: file.uri });
}
