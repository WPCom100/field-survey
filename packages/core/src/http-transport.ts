/**
 * `SyncTransport` over HTTPS with the interim identity (D69, D77): the shared bearer token and
 * `X-Survey-User`. Uses the runtime's `fetch` (React Native and Node 24 both have one); tests
 * inject a stub. T04 swaps the token for the Entra access token without touching the engine.
 */

import type { PullResponse, PushBody, PushResponse, SyncTransport } from './sync';
import { TransportError } from './sync';

export interface HttpTransportOptions {
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

export class HttpTransport implements SyncTransport {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpTransportOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, '');
    this.fetchImpl = (opts.fetch ?? globalThis.fetch) as FetchLike;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (typeof this.fetchImpl !== 'function') throw new Error('HttpTransport: no fetch available');
  }

  push(body: PushBody): Promise<PushResponse> {
    return this.request<PushResponse>('POST', '/ops', body);
  }

  pull(projectId: string, since: number, limit: number): Promise<PullResponse> {
    const q = new URLSearchParams({ project_id: projectId, since: String(since), limit: String(limit) });
    return this.request<PullResponse>('GET', `/ops?${q.toString()}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
    };
    if (this.opts.userName) h['X-Survey-User'] = this.opts.userName;
    return h;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      const init: RequestInit = { method, headers: this.headers() };
      if (body !== undefined) {
        init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      if (controller) init.signal = controller.signal;
      res = await this.fetchImpl(this.base + path, init);
    } catch (e) {
      throw new TransportError('network', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      let detail: unknown = null;
      try {
        detail = await res.json();
      } catch {
        /* no JSON body */
      }
      const failure =
        res.status === 401 ? 'auth' : res.status >= 400 && res.status < 500 ? 'rejected' : 'server';
      throw new TransportError(failure, `${method} ${path.split('?')[0]} → ${res.status}`, res.status, detail);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new TransportError('server', `Bad JSON from ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
