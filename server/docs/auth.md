# Authentication — server (T60, T03; D69, D77, D264)

Every route but `GET /health` and `GET /auth/config` needs `Authorization: Bearer <…>`. What the bearer may be is
`AUTH_MODE` in `.env`:

| `AUTH_MODE` | Bearer | Who the caller is |
|---|---|---|
| `token` (interim, D69) | `SURVEY_SHARED_TOKEN` | the `X-Survey-User` name: an `app_user` found by trimmed, case-insensitive name (interim rows first, then signed-in ones) or created with `entra_oid` null |
| `entra` (T03) | an Entra ID access token for this API | the `app_user` whose `entra_oid` is the token's `oid` |
| `both` (transition) | either of the above | as for that bearer |

The Mac rig and the e2e harness stay on `token`. An unknown mode answers 500 on every
authenticated route.

## Token validation (`app/entra.py`)

- RS256 only. The header's `kid` picks a key from the tenant's JWKS
  (`ENTRA_JWKS_URL`, default `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys`).
- `iss` must equal `ENTRA_ISSUER` (default `https://login.microsoftonline.com/<tenant>/v2.0`, a
  v2.0 access token: set `accessTokenAcceptedVersion: 2` in the API registration's manifest).
- `aud` must be one of `ENTRA_AUDIENCE` (comma-separated: the API's client id, `api://field-survey`).
- `exp`, `iss`, `aud`, `oid` are required; `exp` / `nbf` allow `ENTRA_LEEWAY_SECONDS` (120) of
  clock skew.
- Name: `name`, else the email, else the oid. Email: the first of `email`, `preferred_username`,
  `upn`, `unique_name` that contains `@`. `given_name` is read when present (merge matching).
- Keys are cached per process. An unknown `kid` or a set older than 24 h refetches, at most once
  per 5 minutes; a failed refresh keeps serving the cached keys. No keys at all → **503**
  "Sign-in keys unavailable". Any other failure → **401** with `WWW-Authenticate: Bearer
  error="invalid_token"`; the reason goes to the `auth` log, never to the client.
- Issuer, audience or tenant missing from `.env` → every bearer is refused (401), as an empty
  shared token refuses everything (D77).

## What the iPad is told: `GET /auth/config` (T04, D265)

Public, like `/health`. The iPad reads it from the server URL it was given:

```json
{"mode": "both", "entra": {"tenant_id": "…", "client_id": "…",
  "scopes": ["openid", "profile", "email", "offline_access", "api://field-survey/access"]}}
```

`entra` is null unless `AUTH_MODE` is `entra` or `both` **and** `ENTRA_TENANT_ID` and
`ENTRA_CLIENT_ID` are set; then the iPad offers "Sign in with Microsoft" (authorization code +
PKCE against `https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/…`, redirect
`fieldsurvey://auth`). `ENTRA_SCOPES` (space-separated, default `api://field-survey/access`) is
what it asks for beside the four OpenID scopes. Nothing in it is a secret (a public client).

## First sign-in and the interim merge (D264)

`GET /me` (and any route that needs the user, e.g. `POST /projects`, `POST /imports`,
`POST /exports`) with a token whose `oid` has no row yet:

- **No merge candidate** → the row is created under the Entra display name; 200.
- **A merge candidate** → **409**:
  ```json
  {"detail": {"error": "merge_pending", "name": "Landry Smith", "email": "landry@…",
              "merge_candidate": {"id": "0190…", "name": "Landry"}}}
  ```
  The candidate is an interim user (`entra_oid` null), the first that matches of: the
  `X-Survey-User` name the iPad sends (the name it was using), the only interim user whose
  name is the Entra display name, the only one whose name is the given name (or the display
  name's first word). Signed-in and system users are never candidates.

The iPad asks (T04), then `POST /me/merge`:

| Body | Effect |
|---|---|
| `{"user_id": "<interim id>"}` | adopts that interim row: it gains the `oid` and email and **keeps its id and name**, so every op it wrote keeps its author and the team picker still finds it |
| `{"user_id": null}` | declines: a new row under the Entra display name |

A retry of the same choice returns the same row; a different choice after one was made is 409
`already_signed_in`; a target that is not an interim user is 409 `not_interim` (404 if unknown).
`POST /me/merge` with the shared token is 400. Email is refreshed from the token on every
sign-in; the name never is.

`GET /me` returns `{"id", "name", "email"}` (email null for interim users).

`POST /ops` still checks only that each op's `user_id` exists (D252); it does not require it to
be the caller's.
