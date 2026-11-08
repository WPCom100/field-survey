import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';

import { TransportError } from '@field-survey/core';

import { cropCacheName, downloadError, failureText } from './model';

/** A crop the server has not answered within this is reported, not left blank (T129). */
const CROP_TIMEOUT_MS = 45_000;

export type CropFile = { state: 'loading' } | { state: 'ok'; uri: string } | { state: 'failed'; message: string };

/**
 * A source crop PNG (`GET /imports/{id}/crop`) downloaded into the cache, so a failure has a
 * reason on screen (T129: an `<Image>` over a starved server stayed grey with no word) and a crop
 * already seen opens offline. `retry` tries again.
 */
export function useCropFile(url: string | null, headers: () => Promise<Record<string, string>>): CropFile & { retry: () => void } {
  const [state, setState] = useState<CropFile>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Asked per download (a Microsoft token may need a refresh first, T04); a new function each render.
  const headersRef = useRef(headers);
  headersRef.current = headers;

  useEffect(() => {
    if (!url) return;
    let live = true;
    const dir = new Directory(Paths.cache, 'crops');
    const dest = new File(dir, cropCacheName(url));
    if (dest.exists && dest.size > 0) {
      setState({ state: 'ok', uri: dest.uri });
      return;
    }
    setState({ state: 'loading' });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransportError('network', 'timed out')), CROP_TIMEOUT_MS);
    });
    const download = (async () => {
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const h = await headersRef.current(); // a TransportError (sign-in needed, offline) as is
      try {
        await File.downloadFileAsync(url, dest, { headers: h, idempotent: true });
      } catch (e) {
        throw downloadError(e);
      }
    })();
    // A download still hanging at the timeout is reported; it may land in the cache later.
    Promise.race([download, timeout])
      .then(
        () => live && setState({ state: 'ok', uri: dest.uri }),
        (e: unknown) => live && setState({ state: 'failed', message: failureText('The crop', e) }),
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [url, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...(url ? state : { state: 'failed', message: 'No crop for this source.' }), retry };
}
