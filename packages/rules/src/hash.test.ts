import { describe, expect, it } from 'vitest';
import { isUuid } from '@field-survey/core';
import { hashOf, hashUuid, sha256Hex, stableStringify } from './hash';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // 56 bytes: the padding straddles a block boundary
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    // non-ASCII goes through UTF-8
    expect(sha256Hex('Stations & Sensors — 06M')).toHaveLength(64);
    expect(sha256Hex('é')).toBe(sha256Hex('é'));
  });
});

describe('stableStringify / hashOf', () => {
  it('ignores key order and undefined, keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
    expect(hashOf({ status: 'Issue', note: null })).toBe(hashOf({ note: null, status: 'Issue' }));
    expect(hashOf([1, 2])).not.toBe(hashOf([2, 1]));
  });
});

describe('hashUuid', () => {
  it('is deterministic, a valid UUID (version 8) and distinct per namespace and parts', () => {
    const a = hashUuid('field-survey:proposal', ['p', 'R3a|cable_end:e1|']);
    expect(a).toBe(hashUuid('field-survey:proposal', ['p', 'R3a|cable_end:e1|']));
    expect(isUuid(a)).toBe(true);
    expect(a.charAt(14)).toBe('8');
    expect('89ab').toContain(a.charAt(19));
    expect(a).not.toBe(hashUuid('field-survey:finding', ['p', 'R3a|cable_end:e1|']));
    expect(a).not.toBe(hashUuid('field-survey:proposal', ['p', 'R3a|cable_end:e1|U']));
    expect(hashUuid('n', ['a', null, 'b'])).toBe(hashUuid('n', ['a', '', 'b']));
  });
});
