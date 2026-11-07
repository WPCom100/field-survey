# Operations — Field Survey server

Production (D67 option A): one DigitalOcean Basic Droplet, 2 vCPU / 4 GB (resized from 2 GB on 2026-10-10, §3.6), Ubuntu 24.04, running the Compose stack in `server/` (Caddy → api, worker, Postgres 16 in the named volume `pgdata`). Objects live in Cloudflare R2. Public name: `https://survey.wpcom.cloud`.

| Thing | Where |
|---|---|
| Droplet | DigitalOcean, `142.93.54.143`, Ubuntu 24.04, SSH as `root` with `~/.ssh/field_survey_droplet` on Landry's PC (deploy key, no passphrase; added to `/root/.ssh/authorized_keys`) |
| Checkout | `/opt/field-survey` (git clone over a read-only GitHub deploy key) |
| Config | `/opt/field-survey/server/.env` (master copy: `server/.env.production` on Landry's PC, never committed) |
| DNS | Cloudflare zone `wpcom.cloud`: `A survey → 142.93.54.143`, **DNS only** (grey cloud), so Caddy can get and renew its Let's Encrypt certificate itself |
| Objects | R2 bucket from `S3_BUCKET`, endpoint `https://<account-id>.r2.cloudflarestorage.com` |
| TLS | Caddy, automatic; certificates in the `caddy_data` volume |

`.env` sets `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`, so on the Droplet a plain `docker compose …` already uses the production override: no local S3 service, Postgres not published to the host, `restart: unless-stopped`, logs capped at 5 × 10 MB per container.

Every command below runs on the Droplet in `/opt/field-survey/server` unless it says "on the PC".

## 1. Provision (once)

1. **Droplet.** Basic, Regular, 2 vCPU / 4 GB, Ubuntu 24.04 LTS, the team SSH key added. Paid Droplet backups off (D67: backups go to R2, §3.1).
2. **DNS.** In Cloudflare, add `A survey 142.93.54.143` with the proxy **off** (grey cloud). Check from the PC: `nslookup survey.wpcom.cloud 1.1.1.1`.
3. **R2.** In Cloudflare → R2, create an API token with *Object Read & Write* scoped to the bucket. Put the account id, bucket, access key id and secret into `server/.env.production` on the PC.
4. **Base setup** (swap, Docker, firewall, unattended upgrades). On the PC:
   ```
   scp -i ~/.ssh/field_survey_droplet server/deploy/provision.sh root@142.93.54.143:/root/
   ssh -i ~/.ssh/field_survey_droplet root@142.93.54.143 bash /root/provision.sh
   ```
   The script is idempotent. It adds a 2 GB `/swapfile` (swappiness 10), installs Docker Engine and the compose plugin, and opens only 22/80/443 in `ufw`.
5. **Checkout.** *(Done 2026-10-10 in T06: deploy key titled `droplet survey.wpcom.cloud`; the earlier tar copy sits in `/opt/field-survey.pre-git`. The Compose project name stays `server`, so the `server_pgdata` volume carried over.)* On the Droplet: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy`. Add the public key as a read-only deploy key (on the PC: `gh repo deploy-key add <pubkey-file> --title droplet`). Then add `Host github.com` / `IdentityFile ~/.ssh/github_deploy` to `~/.ssh/config` and run `git clone git@github.com:WPCom100/field-survey.git /opt/field-survey`.
6. **Config.** On the PC: `scp -i ~/.ssh/field_survey_droplet server/.env.production root@142.93.54.143:/opt/field-survey/server/.env`. On the Droplet: `chmod 600 .env`.
7. **Start.**
   ```
   docker compose build
   docker compose up -d postgres
   docker compose run --rm api alembic upgrade head
   docker compose run --rm api python -m app.storage check     # writes/reads/deletes one R2 object
   docker compose up -d
   ```
8. **Check** from anywhere (PC or iPad Safari for the first line):
   ```
   curl https://survey.wpcom.cloud/health                       # {"status":"ok","commit":…,"migration":…}
   curl -H "Authorization: Bearer <SURVEY_SHARED_TOKEN>" https://survey.wpcom.cloud/team
   ```
   In the app: first launch asks for the server URL (`https://survey.wpcom.cloud`) and the shared token, then shows the team picker (Landry, Zach, Wiley).

## 2. Update (D154, T85)

### 2.1 Automatic: push to `main`

Every push to `main` runs `.github/workflows/ci.yml`. When the `server`, `client` and `e2e` jobs pass:

1. **`deploy`** SSHes to the Droplet with the deploy-only key and sends the commit sha. The key is a forced command (§2.3), so the Droplet runs `server/deploy/deploy.sh <sha>`:
   `git fetch` + `git checkout --detach <sha>` → `docker compose build` (the old containers keep serving) → `pg_dump -Fc` to `/root/deploys/<sha>.dump` (the newest 10 are kept) → `alembic upgrade head` → `docker compose up -d` → waits up to 2 min for the api's `/health` to report the sha. A failing step exits non-zero, so a failed build, dump or migration stops before `up -d` and the old stack is still serving. The job then checks the public `https://survey.wpcom.cloud/health` too.
2. **`update`** (only after `deploy` passed, only on a push) publishes the JS to the `production` channel from Linux, with the commit subject as the message (§5.5, D157). TestFlight iPads take it on their next two launches.

`concurrency` groups `deploy` and `update` keep two pushes from overlapping; a newer push waiting in line replaces an older one that has not started. A red job emails the repo owner. **Accepted consequence (D154 (5)):** every push to `main`, a mid-task commit included, reaches the field iPads.

Check a deploy: `curl -s https://survey.wpcom.cloud/health` → `{"status":"ok","commit":"<sha>","migration":"<alembic revision>"}`; the iPad's Sync screen shows the same short commit beside the server URL. `eas update:list --branch production --non-interactive` shows the new update row.

**Migrations run automatically**, behind the dump (D154 (3)). They are forward-only in `packages/core`; on the server a bad one is recovered from the dump (§2.4).

### 2.2 Manual fallback

The same script, by hand on the Droplet (when GitHub Actions is down, or to watch every step):

```
bash /opt/field-survey/server/deploy/deploy.sh <full 40-character sha>
```

Then publish the JS from the PC (§5.5, *Publish*), unless the deploy was a rollback. The commit `/health` reports is whatever `GIT_SHA` the image was built with: a plain `docker compose up -d --build` without the script reports `dev`.

Changing `.env`: edit the master copy on the PC, `scp` it as in §1.6, then `docker compose up -d` (containers whose env changed are recreated). No deploy needed.

### 2.3 Secrets and the deploy key (once)

| GitHub secret (repo → Settings → Secrets and variables → Actions) | What | Made by |
|---|---|---|
| `DROPLET_SSH_KEY` | private half of a **deploy-only** ed25519 key, no passphrase | Claude in T85 (2026-10-13) |
| `DROPLET_HOST` | `142.93.54.143` — the IP, because the pinned `server/deploy/known_hosts` names the IP | Claude in T85 |
| `EXPO_TOKEN` | an Expo **robot** token (expo.dev → account → Access tokens → Robot users), role Developer | Landry (2026-10-13) |

Make a new deploy key (rotation, or a new Droplet). On the PC, in Git Bash, outside the repo:

```
ssh-keygen -t ed25519 -N "" -C "github-actions deploy" -f ~/field_survey_ci
gh secret set DROPLET_SSH_KEY < ~/field_survey_ci
gh secret set DROPLET_HOST --body 142.93.54.143
```

Then put the public half on the Droplet as a forced command, so the key can run nothing but the deploy script (the sha arrives as `$SSH_ORIGINAL_COMMAND`):

```
echo "restrict,command=\"bash /opt/field-survey/server/deploy/deploy.sh\" $(cat ~/field_survey_ci.pub)"   | ssh -i ~/.ssh/field_survey_droplet root@142.93.54.143 'cat >> /root/.ssh/authorized_keys'
rm ~/field_survey_ci ~/field_survey_ci.pub
```

Remove the old line from `/root/.ssh/authorized_keys` when rotating. A new Droplet also needs a new `server/deploy/known_hosts` (`ssh-keyscan -t ed25519 <ip>`, checked against the DigitalOcean console) and a new `DROPLET_HOST`. The Droplet's own read-only GitHub deploy key (§1.5) is separate and unchanged.

### 2.4 Roll back

1. **Server:** GitHub → Actions → *ci* → **Run workflow** with the previous good sha (or `gh workflow run ci.yml -f sha=<sha>`). It tests that commit and deploys it; it never publishes an update. If the bad deploy ran a migration, the old code does not downgrade it: restore `/root/deploys/<bad sha>.dump` (taken just before that migration) with §3.3 after the rollback deploy, or fix forward.
2. **JS:** `eas update:republish` of the previous update group (§5.5, *Roll back*), never past a `packages/core` migration.

## 3. Backup and restore

### 3.1 Automated backups (T06, D79)

The `worker` runs `app/backup.py` once a minute (`backup.tick()`). With `BACKUP_ENABLED=true`:

| Job | When | What |
|---|---|---|
| Dump | daily, first tick at or after `BACKUP_HOUR_UTC` (08 = 03:00 Houston CDT / 02:00 CST) | `pg_dump -Fc` → `S3_BUCKET/backups/pg/survey-<UTC stamp>.dump` |
| Prune | right after each dump | deletes dumps older than `BACKUP_RETENTION_DAYS` (90), always keeping the newest. Done in code because the R2 token is Object Read & Write only and gets AccessDenied on bucket lifecycle rules |
| Master export | daily, first tick at or after `BACKUP_HOUR_UTC` (D149, D152, T82) | one xlsx export per project by the `export` user into the bucket (`blobs/<sha256>`, in the export history), **skipped when the project has no edit since its last one**; files older than `EXPORT_BACKUP_RETENTION_DAYS` (183 ≈ 6 months) are deleted, each project's newest always kept. See `server/docs/exports.md` |
| Copy | once per ISO week, on or after `BACKUP_COPY_WEEKDAY` (7 = Sunday), after that day's dump | `rclone copy --checksum --no-update-modtime` (never `sync`) of the **whole** main bucket (photos, sheets, dumps) to `BACKUP_COPY_BUCKET`; writes `backups/copy-markers/<year>-W<nn>` when done. Skipped (log `backup_copy_skipped`) while `BACKUP_COPY_BUCKET` is empty. Killed after `BACKUP_COPY_TIMEOUT_MINUTES` (60); a failed copy logs `backup_copy_backoff` and is not tried again until the next day (T123, D225) |

"Already done" is read from R2 (today's dump key, this week's marker), so a restart or a missed night simply runs on the next tick. A failure logs `backup_failed` and retries a minute later. A failed **copy** waits for the next day instead, because the worker is serial and a copy retried every minute starved the job queue (2026-10-18, T123). With the copy on Sunday, a failed copy is not retried until the next week unless it is run by hand. Nothing stops the worker. The copy bucket keeps everything it has ever received, because dumps pruned in the main bucket are not deleted there.

By hand (in `/opt/field-survey/server`):

```
docker compose exec worker python -m app.backup list            # dumps in R2
docker compose exec worker python -m app.backup dump            # dump now
docker compose exec worker python -m app.backup copy            # copy now
docker compose exec worker python -m app.backup copy -vv --dump headers   # copy now, every request and response logged (T123)
docker compose exec worker python -m app.backup prune
docker compose logs worker | grep backup_                        # backup_dump / backup_prune / backup_copy / backup_failed
docker compose logs worker | grep export_                        # export_daily_unchanged / export_backup_pruned / export_daily_failed
```

**Copy bucket:** `field-survey-backup`, same account and same token as the main bucket (set up 2026-10-10; first copy 06:01:35Z, `rclone check` 0 differences). To set one up again: In Cloudflare → R2, create the bucket (suggested `<S3_BUCKET>-copy`). Then create an API token with *Object Read & Write* on **both** buckets, or a separate token for the copy bucket. In `server/.env.production` set `BACKUP_COPY_BUCKET`, and `BACKUP_COPY_ACCESS_KEY`/`BACKUP_COPY_SECRET_KEY` (+ `BACKUP_COPY_ENDPOINT` if it is in another account) when the token differs from `S3_*`. Then `scp` it as in §1.6, run `docker compose up -d worker`, run the copy by hand once and check the bucket in the dashboard.

**rclone and R2 (T123, D225).** The image installs rclone from its own release (`RCLONE_RELEASE` + `RCLONE_ZIP_SHA256` in `server/Dockerfile`), not Debian's 1.60. The weekly copy failed on 2026-10-18 with `NotImplemented` (501) on every object, the first copy onto a non-empty copy bucket. The likely cause is the self-copy rclone sends to fix a destination object's modtime, which R2 refuses, so the copy compares by size + MD5 (`--checksum`) and never rewrites what is already there (`--no-update-modtime`). That is safe because objects are never overwritten (A14). The fix was checked on the Droplet on 2026-10-30: a copy with no 501, then a second one with nothing to transfer. If a copy fails again, run it by hand with `-vv --dump headers` and look for the request just before the 501.

### 3.2 Manual dump

The deploy script takes one before every migration (§2.1, `/root/deploys/<sha>.dump`). By hand:

```
docker compose exec -T postgres pg_dump -U survey -Fc survey > /root/survey-$(date +%F-%H%M).dump
```

### 3.3 Restore

1. Get a dump: a manual one from `/root`, or the latest from R2:
   ```
   KEY=$(docker compose exec -T worker python -m app.backup list | tail -1)
   docker compose exec -T worker python -m app.backup fetch "$KEY" > /root/restore.dump
   ```
   On a new Droplet with no stack yet, use the Cloudflare dashboard (R2 → bucket → `backups/pg/` → Download) and `scp` the file up.
2. Stop writers: `docker compose stop api worker` (skip for a drill).
3. Restore into a scratch database first and look at it:
   ```
   docker compose exec -T postgres createdb -U survey survey_restore
   docker compose exec -T postgres pg_restore -U survey -d survey_restore --no-owner --exit-on-error < /root/restore.dump
   docker compose exec postgres psql -U survey -d survey_restore -c "select count(*) from op"
   ```
4. Swap it in:
   ```
   docker compose exec postgres psql -U survey -d postgres -c "alter database survey rename to survey_old"
   docker compose exec postgres psql -U survey -d postgres -c "alter database survey_restore rename to survey"
   docker compose start api worker
   ```
5. Once the app checks out, `drop database survey_old`.

R2 objects are content-addressed and never overwritten (A14), so restoring the database never needs a matching object restore. Rows may point at blobs that were uploaded after the dump. The iPads still hold those and re-sync them. If the main bucket itself is lost, point `S3_BUCKET` at the copy bucket (§3.1) until a new main bucket is filled with `rclone copy` the other way.

### 3.4 Lost Droplet

Create a new Droplet, follow §1, restore the latest dump from R2 (§3.3, step 3 straight into `survey`), then point DNS at the new IP. The iPads keep their outboxes and push again once the server answers.

### 3.5 Restore drill log

| Date (UTC) | Dump | Steps (§3.3, into `survey_restore`, writers left running) | Result |
|---|---|---|---|
| 2026-10-10 (T06) | `backups/pg/survey-2026-10-10T054850Z.dump`, 97,397 bytes, taken 05:48:50Z | start 05:50:46Z → fetched from R2 05:50:49Z → `pg_restore --exit-on-error` done 05:50:51Z → scratch dropped 05:50:52Z | Row counts identical to live on all 30 tables (incl. `app_user` = 3), `alembic_version` = `0001`. 6 s end to end at this size |

Repeat the drill after T27 (first real data) and then once per milestone; add a row each time.

### 3.6 Resize the Droplet

DigitalOcean → Droplet → Power off → Resize → **CPU and RAM only** (keeps the disk, so it can be resized back) → Power on. Compose restarts on boot (`restart: unless-stopped`); check with `docker compose ps` and `/health`.

## 4. Day to day

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f --tail=200 api` (or `worker`, `caddy`) |
| Memory / swap | `free -h`; per container `docker stats --no-stream`. The worker is capped at 2 GB (`docker-compose.prod.yml`, T124): a job past it kills the worker alone, the API keeps answering, and `docker compose logs worker \| grep import_recovered` shows the batch re-queued (first time) or failed (second) |
| Crops / riser blank on the iPads | Since T129 the iPad says why (timeout, not reachable, 404, 5xx). On the server: `curl -s https://survey.wpcom.cloud/health`; `docker compose logs --timestamps api \| grep -E '/crop\|/blobs/.*/content\|GET /imports' \| tail -50` (status and time of each crop and download); `docker compose logs --timestamps caddy \| grep -E '50[234]' \| tail` (the API not answering behind Caddy); then the Memory row above. Logs are capped at 5 × 10 MB per container, so an old window may be gone |
| Disk | `df -h /` and `docker system df` |
| Prune old images | `docker image prune -f` after an update |
| Rotate the shared token | new `SURVEY_SHARED_TOKEN` in `.env`, `docker compose up -d api`, then re-enter it on each iPad |
| Add a team name | `TEAM_NAMES_CSV` in `.env` or `POST /team` |
| Rotate the Claude API key (D189) | new key in the Anthropic Console → `ANTHROPIC_API_KEY` in `server/.env.production` on the PC (and `server/.env` for local runs) → `scp` as in §1.6 → `docker compose up -d worker`; revoke the old key last. `CLAUDE_MODEL` sits beside it (`claude-opus-5-5`; `claude-fable-5-1` to step up) |
| OCR (tesseract) | in the image via `apt-get install tesseract-ocr` (Dockerfile) and in CI; `docker compose exec worker tesseract --version` to check. On the PC: the UB-Mannheim build at `C:\Program Files\Tesseract-OCR` (or `TESSERACT_CMD`), see §4.1 |

Monitoring: an external uptime monitor pings `https://survey.wpcom.cloud/health` (PLAN §8). The worker heartbeat row arrives with the job runner.

### 4.1 Pending actions (2026-10-15)

- **Replace the temporary Claude API key.** The key now in `server/.env` and `server/.env.production` was pasted into a Claude Code chat on 2026-10-15 (so it has been through a transcript) and is marked `TEMPORARY` in both files. Rotate it per the runbook row above once T43 is deployed and working; it has not been copied to the Droplet yet — T43 has shipped, so do that now with the §1.6 `scp` + `docker compose up -d worker` (until then a riser upload on the Droplet lands its drafts without endpoints, `stats.claude = unavailable`). The T43 recording run on the PC spent about $2 of this key (26 band calls at effort high).
- ~~**Install Tesseract on the PC.**~~ *(Done 2026-10-15 by Landry: `winget install UB-Mannheim.TesseractOCR` → `tesseract v5.4.0.20240606` at `C:\Program Files\Tesseract-OCR`. The OCR tests now run on the PC: 9 pass, 3 fail by one row — this build drops BOM p.3 line 630 (`P-DOC-C-SR-4`, qty 1, FLOOR 20) that the Linux `tesseract-ocr` of the image and CI reads → **T109**. The Droplet uses the image, so production is unaffected.)* `server/app/ocr.py` looks for `C:\Program Files\Tesseract-OCR\tesseract.exe` (or `TESSERACT_CMD`). The installer is already downloaded — `winget install UB-Mannheim.TesseractOCR` or https://github.com/UB-Mannheim/tesseract/wiki — but it needs a UAC prompt the Claude Code shell cannot show, so run it by hand. Until then the 4 OCR tests in `server/tests/test_bom.py` skip with that reason on the PC; they pass in the api container (`docker compose build api`, then run pytest inside it with `fixtures/`, `app/` and `tests/` mounted) and in CI.

### 4.2 Moving a project to the D196 categories (T112, D201)

The eleven categories replace the master's eight through a rename ruling applied **on the iPad**,
not by the server. Per project, in this order: (1) run the DaVinci library import (T111) so the
catalogue types with their roles exist; (2) Setup → Vocabulary → **Load standard values** — adds
the eleven and marks `Relay panel`, `Foundry panel`, `EBDK`, `NSPS`, `Equipment rack` as old
spellings; (3) Lint → Value outside vocabulary → **Fix all via ruling**, one rename per old
spelling (standing, with who / when / reason). A device whose new category names no role
(`Power Distribution`, `Equipment`) is read by its library type: on Centennial the 11 relay
panels (`CTxxLCPA/B`, whose Device text is the panel tag) need their type picked on the card
afterwards; the NSPS, EBDKs, rack and Foundry panels match by Device text or category.

## 5. iOS builds and TestFlight (T06b, D59, D70)

All on the PC in `app/`, in **your own terminal** (EAS asks for the Apple ID password and 2FA code interactively). Needs the Apple Developer Program membership **active** (developer.apple.com → Account → Membership shows a Team ID). Nothing here needs a Mac. **Always run `eas` from `app/`**: from the repo root it writes a stray `eas.json`/`app.json` there and fails with "The `expo` package was not found". Apple team `H2CLZXHCH8`; commands that need it non-interactively take `--apple-team-id H2CLZXHCH8` (e.g. `eas device:list`).

### 5.1 Once per project

1. `eas login` (the Expo account), then `eas init` → writes `extra.eas.projectId` and `owner` into `app.json`; commit that.
2. **App Store Connect API key.** (Done in T06b the easy way: the first `eas submit` offered to generate the key and stored it in EAS.) Manual route: appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, name `EAS`, access **Admin** → download the `.p8` (once only; keep it in the password manager, never in the repo) and note the Key ID and Issuer ID. Then `eas credentials` → iOS → production → App Store Connect: Manage your API Key → set up a new key with those three values.
3. **Devices.** `eas device:create` → "Website" → open the link/QR on each team iPad in Safari → install the profile (Settings → General → VPN & Device Management). Every new iPad needs this **and** a new development build (the build's profile lists the devices).
4. **App record.** App Store Connect → Apps → **+** New App: iOS, name `Field Survey`, language English (U.S.), bundle ID `productions.luminarytechnology.fieldsurvey` (EAS registers the bundle ID on the first build; if it is not in the list yet, do 5.2 first), SKU `field-survey`, Full Access. Copy the Apple ID (numeric) of the app into `eas.json` → `submit.production.ios.ascAppId`.
5. **Team.** Users and Access → **+** for each team member (role Developer is enough), then TestFlight → Internal Testing → **+** group `LTP team` → add them; "Automatically distribute" on.

### 5.2 Development build (whenever a native module changes)

```
eas build --profile development --platform ios
```

Install from the QR/link on the build page in Safari. The **Developer Mode** toggle only appears after a development-signed app is installed *and launched once* (iPadOS blocks it): then Settings → Privacy & Security → bottom of the list → **Developer Mode** on → restart → Turn On. Daily work: `npx expo start --dev-client` on the PC, iPad on the same Wi-Fi, open the project from the dev client (allow Node.js through Windows Firewall on private networks if the iPad cannot connect).

### 5.3 TestFlight build (at least every 60 days, D59)

```
eas build --profile production --platform ios
eas submit --platform ios --latest
```

The build number auto-increments in EAS (`appVersionSource: remote`). Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption: false`, HTTPS only). Processing in App Store Connect takes 5–30 min; the `LTP team` group gets it automatically. TestFlight builds expire after 90 days. `.github/workflows/build-expiry.yml` runs every Monday and fails (GitHub emails the owner) once the newest finished production build is older than 50 days; that email is the reminder (D154 (6)). Run it any time from Actions → *build-expiry* → Run workflow.

### 5.4 Build log

Two row types. A **build** row has the profile, the EAS build id and the build number. An **update** row (T84, §5.5) has `update` in the Profile column, the update group id in the id column and the runtime version (first 8 characters) in the Build no. column; its Notes say which commit and message it carries. Since T85 a **deploy** row (CI run id, migration) is added for deploys worth noting; routine CI deploys and updates are in GitHub Actions and `eas update:list`. Builds and updates after 2026-10-10 that are not listed here are noted in `TASKS.md` under their task.

| Date | Profile | EAS build / update group id | Build no. / runtime | Notes |
|---|---|---|---|---|
| 2026-10-10 | development | `19e26a75-0635-4624-acbe-f062b37e5291` | 1 | internal (ad hoc), SDK 57, commit `0e188fc`; installed on Landry's iPad (UDID `00008122-001070500251801C`), Developer Mode on; `npx expo start --dev-client --lan` bundled 1268 modules, IdentityGate shown |
| 2026-10-10 | production | `833be746-0079-4511-a0d6-ca0281475c0a` | 2 | store; `eas submit --latest` uploaded to ASC app `6821263690`; TestFlight internal group `LTP team` (auto-distribute), Zach invited |
| 2026-10-10 | development | `b146b497-c5c0-493c-9618-d69fc3797b48` | 2 | internal (ad hoc); EAS shows commit `d8c30e9` because the T07 tree was uploaded before it was committed (content = `cb23a55`); development and production profiles keep separate build counters; adds `expo-sqlite` + `expo-crypto` (T07); installed on Landry's iPad over build 1; first launch logged `[store] open: search=fts5 install=01a124c1-95f1-70d4-bf84-e9568f1399b9` (A21 confirmed on device). Note: since RN 0.77 app logs show in React Native DevTools (press `j` in Metro, Console tab, then `r`), not in the terminal |
| 2026-10-13 | development | `eb79ee85-4646-42e1-8d65-e039521624cf` | 10 | T84, commit `0bf4507`: **errored** in *Configure expo-updates*, runtime version mismatch (PC `9099e69e`, EAS `78875d8a`); fixed in `bb75d8f` (§5.5 "Keep the fingerprint the same everywhere") |
| 2026-10-13 | production | `64602bf5-2fc4-4e41-9acf-8e8cd834c308` | 11 | T84, commit `0bf4507`: errored the same way, never submitted |
| 2026-10-13 | development | `eb4162d7-1894-4cd2-8345-b28c2371d505` | 12 | T84, commit `bb75d8f`: first dev build with `expo-updates`, channel `development`, runtime `d28d6fee` = PC fingerprint (`eas fingerprint:compare` ✅) |
| 2026-10-13 | production | `0d2a6ba6-052b-45b7-a7c9-595ccd11d88d` | 13 | T84, commit `bb75d8f`: first TestFlight build with `expo-updates`, channel `production`, runtime `d28d6fee73a968bab537ea58be2093f7b41861bc` = PC fingerprint; `eas submit` (submission `59658f1e`) uploaded to ASC app `6821263690`. No update published yet; the first one is part of the T84 on-device checks |
| 2026-10-13 | deploy | CI run `38339817304` | migration 0005 | T85, first automatic deploy: Droplet `2444a69` → `15f7656` (brings the T81/T82 server code); `deploy.sh` fetch 03:05:21Z → dump `/root/deploys/15f7656….dump` → migrate → up 03:05:34Z → `/health` reported the sha 03:05:59Z; job 44 s |
| 2026-10-13 | update | `2231ecb1-8b41-4e23-bf85-0bbb366e5ead` | `d28d6fee` | T85, the first update ever and the first from CI (robot `Field Survey`): commit `15f7656` "T85: Fix the ci.yml escapes (YAML did not parse)", carries the JS of T81–T85 to TestFlight build 13 |
| 2026-10-14 | data | project `01a13851-9b1d-71d9-8444-45acae2867f2` | server `d145902` | TP-3 synthetic project (T32, D142, D161): composite `scp`'d to `/root/06M.pdf`, `docker compose cp` into the worker, `docker compose exec -T worker python -m app.jobs.synthetic --name "TP-3 synthetic" --sheet /tmp/06M.pdf`; 02:50–03:49Z (thumbnails 55 min, ops 4 min); 31,089 ops, 2,000 devices, 10,000 photos, ≈ 110 MB in R2; both PDF copies deleted. Soft-deleted 2026-10-18 (row below) |
| 2026-10-15 | development | `a5cbf96f-edc8-4902-8c42-4338c76368ef` | 14 | T92 native patch, commit `14a2309` (logged 2026-10-18 from `eas build:list`) |
| 2026-10-15 | production | `feb9b8d0-4dd8-4b96-a857-0a43ea737712` | 15 | commit `422a649`, runtime `24fe50c2`; submitted (`dd1f4ac0`) to TestFlight (logged 2026-10-18 from `eas submit:list`) |
| 2026-10-18 | deploy | CI run `39098414955` | migration 0017 | Droplet `b23bf52` → `234fa4a`: every push since 2026-10-15 had failed CI on `test_riser_job_with_claude_endpoints` (the recording's byte keys never matched Linux's PNG bytes), so deploy and update were skipped; fixed by keying the replay on image size (`234fa4a`) |
| 2026-10-18 | update | `89a75db0-7dca-454d-8c43-e6ed4959c51f` | `24fe50c2` | from CI, commit `234fa4a`; carries T95–T122 to TestFlight build 15 |
| 2026-10-18 | data | all six projects | server `234fa4a` | Cleared for the full-pipeline iPad round (Landry): Scratch, meth cooking lab, Houston Methodist Hospital, Tower M3 Round Testing, cuck chair, TP-3 synthetic soft-deleted by one `delete` op each through the push loop (`Correction`, user Landry), so iPads hide them at their next pull; restore = a `restore` op. Dump first: `/root/survey-before-clear-2026-10-18-0459.dump` |
| 2026-11-01 | data | both live projects | server `f6c6aa0` | Cleared again for a fresh iPad round (Landry): Pipeline Test (`01a15283-40ce-7cd1-96b0-2ed5c2e0a311`) and Scratch (`01a14e08-3673-7821-b08e-c50df471ee28`) soft-deleted by one `delete` op each through `apply_push` (`Correction`, user Landry, reason "Cleared for a fresh iPad round"), run in the api container with `PYTHONPATH=/srv`; the app library is untouched; restore = a `restore` op. Dump first: `/root/survey-before-clear-2026-11-02-0124.dump` |

### 5.5 JS updates (T84, D153, D157)

A TestFlight build runs its embedded JS until an **update** is published to its channel. At launch the app starts at once on the JS it has, checks for an update in the background (`checkAutomatically: ON_LOAD`, `fallbackToCacheTimeout: 0`) and applies a downloaded update on the **next cold launch**. So a TestFlight iPad gets new JS by launching the app twice (swipe it away from the app switcher in between). An offline iPad starts exactly as before and catches up the next time it launches online. The Sync screen's Install section shows the runtime version, the running update (or "embedded") and a **Check for update** button.

**Build or update?** The runtime version is a fingerprint of everything native: `app.json`, config plugins, native modules, the `react-native-pdf` patch (D92), the lockfile entries of native packages. An update only reaches binaries with the same runtime version.

| The change touches | Ship it with |
|---|---|
| Only TypeScript under `app/src`, `packages/core`, `packages/rules` | an update |
| A native module, `app.json`, `eas.json` build settings, a config plugin, a package patch, an Expo SDK bump | a new build (§5.2 and §5.3), then updates again |

Check before publishing: `cd app && npx expo-updates fingerprint:generate --platform ios` prints the hash the update will carry. If it is not the runtime version of the current TestFlight build (`eas build:list --platform ios --profile production --limit 1`), the change needs a build; an update published anyway reaches nobody.

**Keep the fingerprint the same everywhere.** EAS fails a build when the runtime version it computes on its Mac differs from the one `eas build` computed on the PC ("Runtime version mismatch" in the *Configure expo-updates* phase). T84 hit this and fixed three causes; keep them fixed: `virtualStoreDirMaxLength: 60` in `pnpm-workspace.yaml` (pnpm's Windows default; macOS and Linux default to 120, which changes every native module's path); `/ios` and `/android` in `app/.gitignore` (the builder has no `.git` and reads only that file, so a prebuilt `ios/` would otherwise count as a bare project); and LF line endings for the raw-hashed `app/.gitignore`, `app/eas.json`, `app/app.json`, `app/package.json` (`.gitattributes`). `app.json` lists `platforms: ["ios"]` because the local CLI otherwise adds `web` and EAS does not. To check without a build: `eas fingerprint:compare --build-id <id> --environment production` against a finished build.

**Publish** (manual fallback; CI does this after the server deploy, §2.1). From `app/`, in Git Bash, with the tree committed:

```
M="T<nn>: <title>"
EXPO_PUBLIC_UPDATE_MESSAGE="$M" eas update --channel production --environment production --platform ios --clear-cache --message "$M"
```

- `EXPO_PUBLIC_UPDATE_MESSAGE` is how the Sync screen knows the message: the EAS manifest does not carry it (D157), so Metro bakes it into the bundle.
- `--clear-cache` is required. Without it Metro reuses a cached bundle that still holds the previous message.
- `--environment production` is required when non-interactive. The project has no EAS environment variables; the flag just has to be there.

**Server first.** An update that needs a new endpoint or migration goes out only after the server deploy (§2). The JS must never call a server that does not have its routes yet.

**See what is out:** `eas update:list --branch production --non-interactive` (newest first, with group ids, messages and runtime versions). `eas channel:view production` shows which branch the channel serves.

**Roll back:** `eas update:republish --group <previous group id> --message "Rollback to <id>: <reason>"` publishes the older JS again as a new update; iPads take it on their next two launches. The Sync screen then shows a new update id with the older update's message, because the message is part of the republished bundle. **Never roll back past an update whose task added a `packages/core` migration.** Migrations are forward-only, and older JS on a newer local schema is not supported. In that case fix forward with a new update. `eas update:roll-back-to-embedded` is the same rule with the build's own JS as the target; use it only when no migration has shipped since that build.

**Development builds** have `updates` off. They load JS from Metro (`npx expo start --dev-client`) and show "JS from the development server (Metro)" on the Sync screen. Nothing is ever published to the `development` or `preview` channels.

Log every published update as an update row in §5.4.

## 6. The Mac test rig (T149, D248)

One Mac runs the **iOS Simulator** (since 2026-11-06 a Mac mini M4 rented from Rent-a-Mac, §6.1; before that Zach's Mac on the office Wi-Fi); Claude drives it with **Maestro** flows (`app/maestro/`) against a **local copy of the server** in Docker. It takes the functional half of the on-device checks (taps, screens, labels, sync between two simulators, offline against a stopped server). What stays on a real iPad: Pencil, camera, true airplane mode, TestFlight and dev builds and their updates, performance on the hardware, and every check of whether the *information* is right (CLAUDE.md §7 5a).

Nothing on the Mac ships. The iPads only ever get EAS builds (§5), and `eas.json` is **not** edited for the rig: it is hashed into the runtime fingerprint, and a `simulator` profile moves the runtime from `24fe50c2` to `bd041b87` (measured 2026-11-03), after which the next CI update would reach no installed build. The profile waits for the next build cycle (T150, D249). Until then the rig builds its own Simulator app locally.

### 6.1 Once: the Mac

Any Apple-silicon Mac with 16 GB or more; a base Mac mini is enough.

**The rig today (2026-11-06):** a dedicated Mac mini **M4, 16 GB, 256 GB**, macOS 26.7.2, rented monthly from **Rent-a-Mac** (rentamac.io), user `rentamac` (admin). On the PC, `~/.ssh/config` has:

```
Host mac
  HostName gate1.rentamac.io
  Port 27848
  User rentamac
  IdentityFile ~/.ssh/field_survey_mac
  IdentitiesOnly yes
  HostKeyAlgorithms ssh-ed25519        # SHA256:BgMqpYWRC9PVXdrt3MfbbjQ3sTujO7sUeWlrfn10yxg, from Rent-a-Mac
  ServerAliveInterval 30
  ServerAliveCountMax 4
```

Login is by key only (`field_survey_mac.pub` is in the Mac's `~/.ssh/authorized_keys`); the account password is in the Rent-a-Mac portal and is needed only for `sudo`. **Never shut down or restart the rented Mac** (no `shutdown`, `reboot`, or a macOS update that restarts): it is a physical machine, and Rent-a-Mac's staff take up to one business day to power it back on. Colima is a `brew services` agent, so Docker comes back by itself after any restart they do. The previous rig (Zach's Mac, behind a WireGuard tunnel since it left the office) is `Host mac-zach`.

Setting up a Mac from scratch (how the rented one was done):

1. **Xcode** (only for the Simulator and the local build). Rent-a-Mac preinstalls it; otherwise the App Store, opened once. Then the simulator runtime: `xcodebuild -downloadPlatform iOS` (about 8.5 GB). If `xcode-select -p` shows `/Library/Developer/CommandLineTools`, which Homebrew's installer leaves behind, point it back: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
2. **Homebrew** (its installer needs `sudo`; over SSH run it with `NONINTERACTIVE=1` and a `SUDO_ASKPASS` helper you delete afterwards), then `brew install node@24 openjdk@17 cocoapods colima docker docker-compose` and Maestro from its tap (`brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro`; `rig.sh setup` would otherwise use the `curl | bash` installer). Then `npm install -g pnpm`.
3. **Docker in Colima**, headless (Docker Desktop needs a click-through at the screen on first launch): `colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 4 --disk 40`, `brew services start colima`, `docker context use colima`, and point Compose at brew's plugin: `~/.docker/config.json` = `{"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]}`. `rig.sh server` then works unchanged.
4. **The repo.** The rented Mac has no GitHub credentials: it was cloned from a `git bundle` of `main` made on the PC, with `fixtures/` (private) sent as a tar over `ssh`; day-to-day changes arrive the same way (tar of the changed files). `origin` points at GitHub for when a read-only deploy key is added.
5. **SSH from the PC**, so Claude Code on Windows runs `ssh mac 'cd field-survey && bash scripts/mac/rig.sh …'` and pulls screenshots back with `scp` (on a Mac of your own: System Settings → General → Sharing → Remote Login). `ssh mac "…"` starts a non-login shell that reads only `~/.zshenv`, so brew, Node, Maestro and Java must be on the path there:

   ```
   # field-survey rig (T149; docs/ops.md §6.1): ssh mac "..." needs these without a login shell
   [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv zsh)"
   export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.maestro/bin:$PATH"
   export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8          # CocoaPods fails without a UTF-8 locale
   # Java 17 for Maestro (Homebrew openjdk@17 is keg-only)
   export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
   export PATH="$JAVA_HOME/bin:$PATH"
   # Docker: Colima (headless; rented Mac, 2026-11-06), its docker context is active
   ```

   Run long commands under `caffeinate -i` (`ssh mac 'cd field-survey && caffeinate -i bash scripts/mac/rig.sh flows'`) so the Mac does not sleep mid-run, and start very long ones (the first `build`) with `nohup … > ~/rig-build.log 2>&1 &` so a dropped connection does not kill them.
6. In the repo: `bash scripts/mac/rig.sh setup`. It checks the Xcode command-line tools, installs Maestro and CocoaPods if they are missing, runs `pnpm install`, and creates and boots the simulator **Field Survey iPad** (the newest iPad Pro device type on the newest iOS runtime). It ends with `rig: ready`. Then `server`, `build`, `metro` and `flows` as in §6.2. On the rented Mac the first `build` took about 15 minutes with Xcode 26.6 and the iOS 26.5 runtime; over SSH it ends with an `osascript … System Events` error after installing the app, which is harmless (Expo tries to bring the Simulator window forward). The very first flow after a fresh Metro can fail in `_launch` because the cold bundle is slow and the dev client's onboarding *Continue* appears late: run it again. Smoke ran green twice in a row on 2026-11-06.

### 6.2 Each session

```
bash scripts/mac/rig.sh server      # Docker: postgres, s3, api on 127.0.0.1:8010 and the worker (upload jobs); token e2e, team Ann/Bob; migrated; bucket made
bash scripts/mac/rig.sh build       # expo run:ios → a local dev client on the simulator (first run 10–20 min: prebuild, pod install)
bash scripts/mac/rig.sh metro       # own terminal: Metro on 8081 for that dev client (EXPO_PUBLIC_RIG=1: no error toasts; `metro --clear` after changing it)
bash scripts/mac/rig.sh open        # loads the app from Metro (the fieldsurvey://expo-development-client deep link)
bash scripts/mac/rig.sh flows       # maestro test app/maestro → smoke.yaml
```

- `build` again only when native code changes (a new module, a patch, an SDK bump): JS changes arrive through Metro, as on the dev iPad. `build --release` embeds the JS (no Metro; flows then run with `RIG_METRO_URL=''`).
- `flows <file.yaml>` runs one flow; `flows --device B` runs on the second simulator. Each run creates its own project on the local server (`Maestro <month-day hour:minute>`), never on the Droplet.
- **Offline:** `rig.sh server stop` makes the app offline from its point of view (edits queue, the status bar shows the pending count); `rig.sh server start` brings it back. `server reset` wipes the local data and resets both simulators' keychains: the stored user id belongs to the old server, and the new one refuses every edit as "unknown user" (T154, T160). The next `rig.sh server` waits for S3 before making the bucket and starts the worker only after the migration (on a fresh database the worker died on the first missing table, T154).
- **Two iPads:** `rig.sh second` boots **Field Survey iPad B** with the same build; `open B`, then `flows --device B` or hand-driven steps on both. `rig.sh two` is the scripted check: `setup.yaml` on A as Ann, `peer.yaml` on B as Bob (opens A's project, sees A's edit, makes one), `peer-back.yaml` on A (sees B's), all on one `PROJECT`.
- **Standing projects (T154):** `rig.sh seed` imports the master workbook through the app into **Maestro master** (the checklist's "Tower round project": 210 devices, 215 punch items, 85 parts) and walks its import review items once. `rig.sh pipeline` makes **Maestro pipeline** (B2–06M, BOM and riser extracted, the 06M sheet; the checklist's "pipeline test"). `rig.sh scale [--photos 1000 …]` runs the TP-3 generator (T32) for **Maestro scale** (about 45 s on the rig: 2,000 devices, 10,000 photos). Make it only in the session that needs it (export at scale, wave 5), last: an iPad pulls every server project at sign-in, so after it every fresh launch pulls 16,000 records and pushes the rules' 1,600 proposals and findings for it, and a flow's first sync takes minutes instead of seconds; `server reset` (then `seed` and `pipeline` again) takes it away. Each is made once per server lifetime: a second run says "skipped", and a project a stopped run left half-made is refused with the fix (`server reset`, or another name through `RIG_SEED_PROJECT`, `RIG_PIPELINE_PROJECT`, `RIG_SCALE_PROJECT`). Later flows open them with `RIG_PROJECT=…` instead of making data by hand.
- **Photos, logs, conflicts (T154):** `rig.sh media [A|B]` puts two PNGs in the simulator's photo library (there is no camera). `rig.sh log [A|B] [regex]` copies the app's log files (`Documents/logs`) out of the sandbox and prints `app.log`'s path, or the lines matching the regex (`rig.sh log A '\[rules\] run'`). `rig.sh conflict <edit-flow> [check-flow]` stops the api, runs the edit flow on A as Ann and on B as Bob (the flow reads `${SIDE}`, A or B), starts the api, syncs A then B, then runs the check flow on both. It needs `RIG_PROJECT` naming a project already on both simulators: `RIG_PROJECT="Maestro c1" rig.sh two`, then `RIG_PROJECT="Maestro c1" rig.sh conflict conflict-status.yaml conflict-check.yaml`. `rig.sh place-two` (T155) is the same orchestration with its own setup: `place-two-setup.yaml` on A (a new project with the 06M sheet and a Station draft ×2 moved to the pool), `place-two-peer.yaml` on B (opens the 06M plan so the sheet is cached), then `conflict place-two-edit.yaml place-two-check.yaml` (one unit placed on each iPad offline; both see `06M-S1`, `06M-S2`, an empty pool, no sync conflict); about 15 min.
- **Flows:** `smoke.yaml` (connect, project, level, sync) and `setup.yaml` (3 Sources → 4 Review drafts → 5 Place devices → the card → sync); the list is in `app/maestro/README.md`. The wave-1 flows (T155) each work on their own data, because they accept drafts and add records a second run would trip over: `ends.yaml` and `lists.yaml` import a fresh copy of the master (`_seed-copy.yaml`, 2.5 min; `flows` stages the workbook), `additions.yaml` makes a project with the 06M sheet. Run one flow at a time: two uploads at once queue on the one worker and a flow's wait runs out. `RIG_USER=Bob` runs as Bob; `RIG_PROJECT` names the project (default `Maestro <date time>`).
- **Files for pickers:** `rig.sh files [A|B] <file>…` puts exactly those files in the simulator's Files app ("On My iPad"); `flows` does it for a flow that includes `_sources.yaml` (the DaVinci pair and the 06M composite from `fixtures/`). Upload jobs need the worker, which `rig.sh server` starts; the Mac's `server/.env` has no Anthropic key, so the riser's far ends stay empty there and nothing calls Claude.
- **Wave 3 (T156):** `rig.sh offline` (O1: a seed copy, every kind of edit with the api stopped, then the server's op table must hold an applied op of each kind made in that window), `rig.sh conflicts` (O2: a status, a ruling against a hand note and an app-library type edited on both simulators offline, resolved with Choose B on A; about 17 min), `rig.sh same-user` (O3: both simulators as Ann; one status and one ink layer; A's log must read `ink_merged`), `rig.sh resume` (O4: a kill and a Re-sign in before the sync keep the edits and the photo). `cmd_conflict` takes `RIG_PEER` for B's user (default Bob). **Error toasts:** Metro from `rig.sh metro` sets `EXPO_PUBLIC_RIG=1` and the app then calls `LogBox.ignoreAllLogs()` in a dev build, because T161's toast sat over bottom-edge buttons (Import, Save) and took the taps; the errors stay in `rig.sh log`. A Metro started any other way shows the toasts again (`_logbox.yaml` still closes one).
- **Pickup, restart, scale (T159):** `rig.sh pickup` (O5: B's edits reach A's open card and open library form with no Sync now, and a three-op library pull while A scrolls is followed by one rules run per project, read from A's log by `scripts/mac/applog.py`; about 10 min). With Maestro scale on the server (`rig.sh scale`, 40 s): `rig.sh scale-check` (W5: a fresh store on A downloads it, the quiet timing line, its 06M plan and the 500-pin demo; the log's numbers against `scripts/mac/scale-ceilings.txt`, `docs/perf/rig.md`; about 4 min), then `rig.sh restart` (O6: ~1,500 punch items generated offline, the api restarted mid-push with `docker compose restart api`; nothing refused, every op applied, numbering continues; about 4–6 min; needs A to hold Maestro scale, so after `scale-check`). Then `server reset`, `server`, `seed`, `pipeline`. A flow with no launch step carries on from the screen the previous flow left (how A keeps a card open while B edits); `RIG_ENV="K=v …"` passes extra flow variables, and every flow gets `SEED` and `SCALE`.
- **A lost user (T160):** `rig.sh stranger` (A as a fresh name; rig.sh deletes that name's `app_user` row with the api stopped while the name queues an edit; the Sync screen then names the lost user and its Re-sign in carries the edit over to the name's new id, D252). It needs only the server and simulator A. A `server reset` resets the simulators' keychains, so the T154 incident does not happen on its own any more; this is how to stage it.
- **Screenshots:** `rig.sh shot [A|B] [file]` prints the file; Maestro keeps its own per failed step under `~/.maestro/tests/`.
- **Logs:** Metro's terminal (press `j` for React Native DevTools, as on the iPad); the server's with `docker compose -f server/docker-compose.yml -f server/docker-compose.e2e.yml logs -f api`.
- `rig.sh status` says what is booted, built and answering.

### 6.3 Writing flows

A flow is YAML (`app/maestro/README.md`): `tapOn: {id: nav.sync}` taps a control by its `testID`, `tapOn: Cancel` by visible text (a regex), `inputText`, `assertVisible`, `extendedWaitUntil`, `runFlow` for sub-flows, `${VAR}` for the values `rig.sh` passes. Rules:

- Controls a flow taps carry `testID="<screen>.<element>"`; the shared `Btn` and `Field` in `app/src/setup/widgets.tsx` pass it through. Add IDs in the task that writes the flow, never a text match on wording that a vocab ruling could change.
- A task whose checks the rig can prove adds a flow (or extends one) and lists it in `TASKS.md`; the on-device checklist keeps only what the iPad or Landry must prove.
- Flows are unverified until they have run on the Mac: T151 is the first run, and its checks sit in `docs/ON_DEVICE_CHECKLIST.md` under T149. `smoke.yaml` first ran green on 2026-11-03 (T151).
- Text matches are a regex over the **whole** text of an element: `Synced .*` misses "● Online · Synced 8:45 PM"; write `.*Synced .*`.
- `launchApp: clearState: true` wipes the app's sandbox but **not the keychain**, where `expo-secure-store` keeps the server, token and name. A run can start on any identity-gate state, and `_launch` / `_connect` handle all three. For a truly fresh run: `xcrun simctl keychain <udid> reset` first.
- The dev client's floating **Tools button** sits over the top-right of every screen ("+ New project") and takes taps meant for it. `_launch` switches it off in the dev menu each run; launch arguments for its UserDefaults key did not take.
- System sheets (iOS's *Save Password?* after the token field) belong to another process: Maestro sees neither the sheet nor the app behind it. `_connect` uses that: if the next screen is not visible, it taps the sheet's button by position.
- The **Files picker** is another process too: the app's tree shows only the popover's `dismiss popup`. `_pick-wait` waits for it before every position tap (an early tap lands on the app: it once ticked "Retire the hand-made app-library types"), and `rig.sh files` keeps "On My iPad" to the files a flow expects, in name order.
- A **flow's own `env:` block beats `-e`**: `smoke.yaml` once ran as Ann under `RIG_USER=Bob`. Top-level flows have none; `rig.sh` passes every variable.
- An **in-app alert** sits over the screen it came from, and both can carry the same text ("Re-sign in"). Anchor the alert's button (`rightOf: Cancel`); `below:` the title picked the screen's button, because the alert's container carries the title and spans its buttons.
- **Off-screen is not there.** `tapOn` and `assertVisible` find only what is on the screen: a long list (Projects on a rig server that has lived a while, the mapping grid, Needs review's device list) needs `scrollUntilVisible` first (T154).
- **`hideKeyboard` fails on the iPad keyboard**; tap a plain label on the form instead (T154, the add-device form).
- **A row's text spans lines** when an item has a line break ("Gain access" + its Device text): the regex still matches across them, so match the distinctive part (`'.*Device "Walter Tower east wing" → link.*'`).
- **Quote a value with a JS expression in it**: `id: "card.status.${SIDE == 'A' ? 'Issue' : 'No access'}"`; unquoted, the `' : '` reads as a YAML key and the flow does not parse (T154).
- **A focused field's keyboard covers what is under it** (Quick actions' Apply on a long card): tap a plain label inside the same scroll view to close it, then tap (T154, `_card.yaml`).
- **The Files picker can open slowly**: once it was still blank and half-sized two seconds after "dismiss popup" showed, and the sidebar tap landed outside it and closed it. `_pick-wait` pauses 5 s (T154).
- **Answer every "Open in Field Survey?"**: a `rig.sh open` left unanswered stacks under the flow's own, and answering *Open* on a running app reloads its JS mid-flow. (Until T153 that reload crashed the dev client in expo-sqlite's FTS5 teardown; the store now opens with `finalizeUnusedStatementsBeforeClosing: false`, D251, and `reload.yaml` reloads twice.) `_devclient` cancels a leftover one.

### 6.4 What a run of the rig cannot tell you

The Simulator runs on the Mac's CPU and GPU: timings (`[plan] …`, `[rules] run`, the Sync screen's timing line) do not transfer to the iPad, and PDFKit's rendering of a heavy sheet feels different. Camera capture does not exist (the photo library does); Pencil pressure does not exist; `expo-updates` is off in a Debug build. Those stay in the checklist.
