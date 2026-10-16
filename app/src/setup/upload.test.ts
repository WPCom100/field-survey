import { describe, expect, it } from 'vitest';

import { uploadForm, uploadPart, type FilePart } from './upload';

/**
 * React Native's FormData as Expo 57 patches it (`expo/src/winter/FormData.ts`): `append` keeps the
 * value as given in `_parts`, `entries()` returns `[name, value]` pairs. Node's own FormData would
 * stringify our part, so the test uses this stand-in.
 */
class PatchedRNFormData {
  _parts: [string, unknown][] = [];
  append(name: string, value: unknown): void {
    this._parts.push([String(name), typeof value === 'object' ? value : String(value)]);
  }
  entries(): [string, unknown][] {
    return this._parts;
  }
}
const make = () => new PatchedRNFormData() as unknown as FormData;

const xlsx: FilePart = {
  uri: 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/DocumentPicker/A.xlsx',
  name: 'Lighting_Control_Survey_Master_B2-06_4.xlsx',
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const reads: string[] = [];
const read = async (uri: string) => {
  reads.push(uri);
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\3\4", a zip header
};

/** Expo's own encoder, loaded at run time so tsc does not type-check Expo's source. */
async function encode(body: FormData): Promise<string> {
  const path = 'expo/src/winter/fetch/convertFormData';
  const { convertFormDataAsync } = (await import(/* @vite-ignore */ path)) as {
    convertFormDataAsync: (f: FormData, boundary?: string) => Promise<{ body: Uint8Array }>;
  };
  const { body: bytes } = await convertFormDataAsync(body, 'B');
  return new TextDecoder('latin1').decode(bytes);
}

describe('file uploads through expo/fetch (T80)', () => {
  it('a picked file becomes a part with its own name and type; bytes are read only when encoded', async () => {
    reads.length = 0;
    const part = uploadPart(xlsx, read);
    expect(part.name).toBe(xlsx.name);
    expect(part.type).toBe(xlsx.type);
    expect(reads).toEqual([]);
    expect(Array.from(await part.bytes())).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(reads).toEqual([xlsx.uri]);
  });

  it('fields come first in order, undefined ones are left out, the file is last as "file"', () => {
    const body = uploadForm(uploadPart(xlsx, read), { project_id: 'p1', kind: 'master_xlsx', mapping: undefined }, make);
    const parts = (body as unknown as PatchedRNFormData)._parts;
    expect(parts.map(([k]) => k)).toEqual(['project_id', 'kind', 'file']);
    expect(parts[0]![1]).toBe('p1');
  });

  it('further file parts follow the file under their own names (the DaVinci mapping workbook, T111)', () => {
    const json = { uri: 'file:///tmp/library.json', name: 'library.json', type: 'application/json' };
    const body = uploadForm(uploadPart(json, read), { project_id: 'p1', kind: 'davinci' }, make, { categories: uploadPart(xlsx, read), missing: undefined });
    const parts = (body as unknown as PatchedRNFormData)._parts;
    expect(parts.map(([k]) => k)).toEqual(['project_id', 'kind', 'file', 'categories']);
    expect((parts[3]![1] as { name: string }).name).toBe(xlsx.name);
  });

  it("Expo's encoder accepts the body: filename, Content-Type and the file's bytes", async () => {
    const body = uploadForm(uploadPart(xlsx, read), { project_id: 'p1', kind: 'plans', level_id: 'l1', sheet_kind: 'display' }, make);
    const text = await encode(body);
    expect(text).toContain('--B\r\ncontent-disposition: form-data; name="project_id"\r\n\r\np1\r\n');
    expect(text).toContain('name="sheet_kind"\r\n\r\ndisplay\r\n');
    expect(text).toContain(
      `content-disposition: form-data; name="file"; filename="${xlsx.name}"\r\ncontent-type: ${xlsx.type}\r\n\r\nPK\x03\x04\r\n--B--\r\n`,
    );
  });

  it("the old React Native part is what Expo's encoder refuses (the iPad error)", async () => {
    const body = make();
    body.append('file', { uri: xlsx.uri, name: xlsx.name, type: xlsx.type } as unknown as Blob);
    await expect(encode(body)).rejects.toThrow('Unsupported FormDataPart implementation');
  });
});
