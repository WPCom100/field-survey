# First Claude Code session — paste this as the opening message

Settings for this session: model **Sonnet 5.5**, effort **Low** (T01 is scaffolding). Run Claude Code (native Windows) from the root of the `field-survey` repo on the Windows PC. Before starting, install: Git, Node 22 LTS, pnpm (`corepack enable`), Docker Desktop, `uv`, and `npm i -g eas-cli` (logged in with `eas login` — not needed for T01 itself, but T06 will need it). No Mac, no Xcode, no Swift anywhere in this project (CLAUDE.md, D70).

---

Read `CLAUDE.md` in full, then `TASKS.md` task **T01 (Repo scaffold)** and the sections of `PLAN.md` it cites (§1 architecture, §8 server API, §9 deployment). `DECISIONS.md` is the decision log; do not change existing lines there.

Before writing anything, restate T01's definition of done in your own words and list the files you will create. If anything in the DoD is ambiguous, ask once, then proceed.

Then do T01:

1. Create the monorepo layout from `CLAUDE.md` §2. The repo already contains `CLAUDE.md`, `PLAN.md`, `DECISIONS.md`, `TASKS.md`, `docs/history/` and `fixtures/`; do not move or edit those except to add `fixtures/README.md` (state that `15090056-BOM.pdf` is a format example only per D4, that `Lake_Dallas_CTE…Punch_List.pdf` is the floor-PDF layout reference per D66, and that the other four files are golden test inputs — D63).
2. Root: `package.json` (private, `packageManager` pinned to the current pnpm), `pnpm-workspace.yaml` covering `app` and `packages/*`, root scripts `test` (`pnpm -r test`), `typecheck`, `lint`; `.gitignore` for Node, Expo, Python and `.env`; `.editorconfig`; `.nvmrc` = 22.
3. `app/`: `npx create-expo-app` with the latest stable Expo SDK and the TypeScript + `expo-router` template. `app.json`: name "Field Survey", slug `field-survey`, iOS bundle id `productions.luminarytechnology.fieldsurvey`, `ios.supportsTablet: true`, iPad only (no iPhone — D74; set `UIDeviceFamily` to iPad via the `ios.infoPlist` key), orientation landscape-preferred, `newArchEnabled: true`. One screen showing "Field Survey". `eas.json` with profiles `development` (`developmentClient: true`, `distribution: internal`), `preview` (internal) and `production` (App Store), plus `cli.appVersionSource: "remote"` and `autoIncrement` on production. Do **not** run any EAS build and do **not** add native modules beyond the template (that is T06/T07).
4. `packages/core`: TypeScript (strict, ESM), `vitest`; exports a `SqlDriver` interface (`exec`, `query`, `transaction`) and a `BetterSqliteDriver` implementation using `better-sqlite3`; one test opens an in-memory DB, creates a table, inserts and reads a row. No React or Expo imports (add an ESLint rule forbidding them in `packages/*`).
5. `packages/rules`: TypeScript, `vitest`; exports an empty `evaluate(snapshot)` returning `{ proposals: [], findings: [] }` with one test. No DB, no React.
6. `server/`: Python 3.12 project managed with `uv` (`pyproject.toml`), package `app` with `app/main.py` exposing FastAPI `GET /health` → `{"status":"ok"}`, `app/worker.py` stub that logs a heartbeat every 60 s and honours `WORKER_CONCURRENCY`, `ruff` configured, one pytest for `/health`. Dependencies: fastapi, uvicorn, sqlalchemy>=2, alembic, psycopg[binary], pydantic-settings, boto3, python-multipart. Do not add extraction/export libraries yet.
7. `server/docker-compose.yml` with services `api`, `worker` (same image), `postgres:16` on a named volume, `minio` (local dev only; production uses Cloudflare R2 through the same S3 settings), `caddy` (with a `Caddyfile` that proxies `/` to `api:8000`; TLS hostname from an env var). `server/.env.example` listing every variable the Compose file and app settings read, with comments, including `AUTH_MODE=token`, `SURVEY_SHARED_TOKEN`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `WORKER_CONCURRENCY`.
8. `.github/workflows/ci.yml` (D73): on push and PR, job `server` (`uv sync`, `ruff check`, `pytest` with a Postgres service container) and job `client` (Node 22, `pnpm install --frozen-lockfile`, `pnpm -r test`, `pnpm typecheck`, `pnpm lint`). No EAS build in CI.
9. Verify on this Windows machine and paste the results: `pnpm install`, `pnpm -r test`, `pnpm typecheck`, `pnpm lint`; `cd server && uv sync && uv run pytest`; `docker compose -f server/docker-compose.yml config`; `cd app && npx expo-doctor` (fix anything it reports); `npx expo export --platform ios` succeeds (proves the JS bundle builds without native tooling).
10. Update `TASKS.md`: T01 → `done`, with a one-line note of any deviation. Append nothing to `DECISIONS.md` unless you had to decide something PLAN does not cover; if you did, add it as D75 with status Proposed.
11. Commit as `T01: Repo scaffold` with a body listing the verification commands and their results. Push.

Finish with the 5-line summary from `CLAUDE.md` §7 (built, tests, deviations, open questions, next task = T02).

Do not start T02. Do not run `eas build`. Do not install `expo-sqlite`, `react-native-pdf`, Skia, camera modules, XlsxWriter, WeasyPrint, tesseract or the Anthropic SDK in this session. Do not create any data model beyond the placeholder test table.
