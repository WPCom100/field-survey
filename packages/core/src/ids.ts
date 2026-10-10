/**
 * UUID v7 (RFC 9562): 48-bit Unix-ms timestamp, 12-bit monotonic counter, 62 random bits.
 * Every record and op id is one (PLAN §2.1). Ids generated in the same millisecond on one
 * install sort in creation order.
 */

export type RandomBytes = (n: number) => Uint8Array;

let installedRandom: RandomBytes | null = null;

/**
 * Install the random source once per process. Node and browsers have `crypto.getRandomValues`;
 * the iPad runtime does not, so the app installs `expo-crypto`'s at start-up (D82).
 */
export function setRandomSource(fn: RandomBytes): void {
  installedRandom = fn;
}

function defaultRandom(n: number): Uint8Array {
  if (installedRandom) return installedRandom(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is not available; call setRandomSource() first');
  }
  return c.getRandomValues(new Uint8Array(n));
}

let lastMs = 0;
let counter = 0;

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

export function uuidv7(now: number = Date.now(), random: RandomBytes = defaultRandom): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = ++lastMs; // counter wrapped: borrow a millisecond
  } else {
    counter = random(2)[0]! & 0x7ff; // start the counter at a random point below 2^11
    lastMs = ms;
  }
  const b = new Uint8Array(16);
  const r = random(8);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((counter >>> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (r[0]! & 0x3f);
  for (let i = 1; i < 8; i++) b[8 + i] = r[i]!;
  let s = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
    s += HEX[b[i]!];
  }
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}
