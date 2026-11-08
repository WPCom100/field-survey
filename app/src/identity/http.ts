import type { HttpClientOptions } from '@field-survey/core';

import type { Identity } from './api';

/**
 * What every `HttpClient` / transport needs (T04): the shared token, or the Microsoft session that
 * hands a fresh token per request. No Expo imports, so modules tested in Node can use it.
 */
export function httpOptions(identity: Identity): HttpClientOptions {
  return {
    serverUrl: identity.serverUrl,
    token: identity.token,
    tokenSource: identity.microsoft?.session ?? null,
    userName: identity.user?.name,
  };
}
