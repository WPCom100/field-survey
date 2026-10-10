/**
 * The HTTP plumbing shared by the op transport (T11) and the blob transport (T12): base URL, the
 * interim identity headers (D69, D77: shared bearer token + `X-Survey-User`), a timeout, and the
 * mapping of failures onto `TransportError`. Uses the runtime's `fetch`; tests inject a stub.
 */

import { TransportError, type TransportFailure } from './sync';

export interface HttpClientOptions {
  /** `https://survey.example.com` (no trailing slash needed). */
  serverUrl: string;
  token: string;
  /** The name picked on this iPad; stamped on every request for the server's `app_user` upsert. */
  userName?: string;
  fetch?: typeof fetch;
  /** Abort a request after this long (ms); default 30 s. */
  timeoutMs?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Method = 'GET' | 'POST' | 'PUT';

/** 401 → auth, other 4xx → rejected (retrying the same data will not help), else server. */
export function httpFailure(status: number): TransportFailure {
  if (status === 401) return 'auth';
  if (status >= 400 && status < 500) return 'rejected';
  return 'server';
}

/** The machine-readable code of a FastAPI error body `{"detail": {"error": …}}`, if any. */
export function errorCode(e: unknown): string | null {
  if (!(e instanceof TransportError)) return null;
  const d = e.detail as { detail?: { error?: unknown } } | null | undefined;
  return typeof d?.detail?.error === 'string' ? d.detail.error : null;
}

export class HttpClient {
  readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, '');
    this.fetchImpl = (opts.fetch ?? globalThis.fetch) as FetchLike;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (typeof this.fetchImpl !== 'function') throw new Error('HttpClient: no fetch available');
  }

  url(path: string): string {
    return this.base + path;
  }

  /** Identity headers for every request (also used by native upload/download tasks). */
  headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.opts.token}` };
    if (this.opts.userName) h['X-Survey-User'] = this.opts.userName;
    return h;
  }

  /** A JSON request; the parsed body on 2xx, `TransportError` otherwise. */
  async json<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...this.headers(), Accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.send(method, path, init);
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new TransportError('server', `Bad JSON from ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Any request; resolves with the 2xx `Response`, throws `TransportError` otherwise. */
  async send(method: Method, path: string, init: RequestInit = {}): Promise<Response> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      const req: RequestInit = { ...init, method, headers: init.headers ?? this.headers() };
      if (controller) req.signal = controller.signal;
      res = await this.fetchImpl(this.url(path), req);
    } catch (e) {
      throw new TransportError('network', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw await failureOf(res, method, path);
    return res;
  }
}

/** A `TransportError` for a non-2xx response, with its JSON body (if any) as `detail`. */
export async function failureOf(
  res: { status: number; json(): Promise<unknown> },
  method: string,
  path: string,
): Promise<TransportError> {
  let detail: unknown = null;
  try {
    detail = await res.json();
  } catch {
    /* no JSON body */
  }
  return new TransportError(
    httpFailure(res.status),
    `${method} ${path.split('?')[0]} → ${res.status}`,
    res.status,
    detail,
  );
}
