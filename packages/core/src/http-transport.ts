/**
 * `SyncTransport` over HTTPS with the interim identity (D69, D77): the shared bearer token and
 * `X-Survey-User`. Uses the runtime's `fetch` (React Native and Node 24 both have one); tests
 * inject a stub. T04 swaps the token for the Entra access token without touching the engine.
 */

import { HttpClient, type HttpClientOptions } from './http';
import type { PullResponse, PushBody, PushResponse, SyncTransport } from './sync';

export type HttpTransportOptions = HttpClientOptions;

export class HttpTransport implements SyncTransport {
  private readonly http: HttpClient;

  constructor(opts: HttpTransportOptions) {
    this.http = new HttpClient(opts);
  }

  push(body: PushBody): Promise<PushResponse> {
    return this.http.json<PushResponse>('POST', '/ops', body);
  }

  pull(projectId: string, since: number, limit: number): Promise<PullResponse> {
    const q = new URLSearchParams({ project_id: projectId, since: String(since), limit: String(limit) });
    return this.http.json<PullResponse>('GET', `/ops?${q.toString()}`);
  }

  /** `GET /health` (public, no token needed): resolves when the server answers 2xx. */
  async ping(): Promise<void> {
    await this.http.send('GET', '/health');
  }
}
