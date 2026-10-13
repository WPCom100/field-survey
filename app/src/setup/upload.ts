/**
 * Multipart file uploads from the iPad (T80). Expo 57 installs `expo/fetch` as the global `fetch`;
 * its FormData encoder takes strings, Blobs and objects with `bytes()` (plus `name` / `type` for the
 * part's filename and Content-Type) and throws "Unsupported FormDataPart implementation" on React
 * Native's `{uri, name, type}` part. So a picked file goes in as an `UploadPart` whose bytes are read
 * from its `uri` when the request is encoded. Pure: the reader is injected (`upload-native.ts` on the
 * iPad, a fake in Node tests).
 */

/** A picked document: where it is on the iPad, its name and MIME type. */
export type FilePart = { uri: string; name: string; type: string };

/** Reads a local file's bytes (expo-file-system's `File.bytes()` on the iPad). */
export type ReadBytes = (uri: string) => Promise<Uint8Array>;

/** What `expo/fetch` encodes as a file part: `filename="<name>"`, `Content-Type: <type>`, `bytes()`. */
export type UploadPart = { readonly name: string; readonly type: string; bytes(): Promise<Uint8Array> };

export function uploadPart(file: FilePart, read: ReadBytes): UploadPart {
  return { name: file.name, type: file.type, bytes: () => read(file.uri) };
}

/** Text fields first (undefined ones left out), then the file as `file` — what `POST /imports` reads. */
export function uploadForm(file: UploadPart, fields: Record<string, string | undefined>, make: () => FormData = () => new FormData()): FormData {
  const body = make();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.append(k, v);
  body.append('file', file as unknown as Blob);
  return body;
}
