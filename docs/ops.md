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
| Copy | once per ISO week, on or after `BACKUP_COPY_WEEKDAY` (7 = Sunday), after that day's dump | `rclone copy` (never `sync`) of the **whole** main bucket (photos, sheets, dumps) to `BACKUP_COPY_BUCKET`; writes `backups/copy-markers/<year>-W<nn>` when done. Skipped (log `backup_copy_skipped`) while `BACKUP_COPY_BUCKET` is empty |

"Already done" is read from R2 (today's dump key, this week's marker), so a restart or a missed night simply runs on the next tick. A failure logs `backup_failed` and retries a minute later. It never stops the worker. The copy bucket keeps everything it has ever received, because dumps pruned in the main bucket are not deleted there.

By hand (in `/opt/field-survey/server`):

```
docker compose exec worker python -m app.backup list            # dumps in R2
docker compose exec worker python -m app.backup dump            # dump now
docker compose exec worker python -m app.backup copy            # copy now
docker compose exec worker python -m app.backup prune
docker compose logs worker | grep backup_                        # backup_dump / backup_prune / backup_copy / backup_failed
docker compose logs worker | grep export_                        # export_daily_unchanged / export_backup_pruned / export_daily_failed
```

**Copy bucket:** `field-survey-backup`, same account and same token as the main bucket (set up 2026-10-10; first copy 06:01:35Z, `rclone check` 0 differences). To set one up again: In Cloudflare → R2, create the bucket (suggested `<S3_BUCKET>-copy`). Then create an API token with *Object Read & Write* on **both** buckets, or a separate token for the copy bucket. In `server/.env.production` set `BACKUP_COPY_BUCKET`, and `BACKUP_COPY_ACCESS_KEY`/`BACKUP_COPY_SECRET_KEY` (+ `BACKUP_COPY_ENDPOINT` if it is in another account) when the token differs from `S3_*`. Then `scp` it as in §1.6, run `docker compose up -d worker`, run the copy by hand once and check the bucket in the dashboard.

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
| Memory / swap | `free -h` |
| Disk | `df -h /` and `docker system df` |
| Prune old images | `docker image prune -f` after an update |
| Rotate the shared token | new `SURVEY_SHARED_TOKEN` in `.env`, `docker compose up -d api`, then re-enter it on each iPad |
| Add a team name | `TEAM_NAMES_CSV` in `.env` or `POST /team` |

Monitoring: an external uptime monitor pings `https://survey.wpcom.cloud/health` (PLAN §8). The worker heartbeat row arrives with the job runner.

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

Two row types. A **build** row has the profile, the EAS build id and the build number. An **update** row (T84, §5.5) has `update` in the Profile column, the update group id in the id column and the runtime version (first 8 characters) in the Build no. column; its Notes say which commit and message it carries. Builds and updates after 2026-10-10 that are not listed here are noted in `TASKS.md` under their task.

| Date | Profile | EAS build / update group id | Build no. / runtime | Notes |
|---|---|---|---|---|
| 2026-10-10 | development | `19e26a75-0635-4624-acbe-f062b37e5291` | 1 | internal (ad hoc), SDK 57, commit `0e188fc`; installed on Landry's iPad (UDID `00008122-001070500251801C`), Developer Mode on; `npx expo start --dev-client --lan` bundled 1268 modules, IdentityGate shown |
| 2026-10-10 | production | `833be746-0079-4511-a0d6-ca0281475c0a` | 2 | store; `eas submit --latest` uploaded to ASC app `6821263690`; TestFlight internal group `LTP team` (auto-distribute), Zach invited |
| 2026-10-10 | development | `b146b497-c5c0-493c-9618-d69fc3797b48` | 2 | internal (ad hoc); EAS shows commit `d8c30e9` because the T07 tree was uploaded before it was committed (content = `cb23a55`); development and production profiles keep separate build counters; adds `expo-sqlite` + `expo-crypto` (T07); installed on Landry's iPad over build 1; first launch logged `[store] open: search=fts5 install=01a124c1-95f1-70d4-bf84-e9568f1399b9` (A21 confirmed on device). Note: since RN 0.77 app logs show in React Native DevTools (press `j` in Metro, Console tab, then `r`), not in the terminal |
| 2026-10-13 | development | `eb79ee85-4646-42e1-8d65-e039521624cf` | 10 | T84, commit `0bf4507`: **errored** in *Configure expo-updates*, runtime version mismatch (PC `9099e69e`, EAS `78875d8a`); fixed in `bb75d8f` (§5.5 "Keep the fingerprint the same everywhere") |
| 2026-10-13 | production | `64602bf5-2fc4-4e41-9acf-8e8cd834c308` | 11 | T84, commit `0bf4507`: errored the same way, never submitted |
| 2026-10-13 | development | `eb4162d7-1894-4cd2-8345-b28c2371d505` | 12 | T84, commit `bb75d8f`: first dev build with `expo-updates`, channel `development`, runtime `d28d6fee` = PC fingerprint (`eas fingerprint:compare` ✅) |
| 2026-10-13 | production | `0d2a6ba6-052b-45b7-a7c9-595ccd11d88d` | 13 | T84, commit `bb75d8f`: first TestFlight build with `expo-updates`, channel `production`, runtime `d28d6fee73a968bab537ea58be2093f7b41861bc` = PC fingerprint; `eas submit` (submission `59658f1e`) uploaded to ASC app `6821263690`. No update published yet; the first one is part of the T84 on-device checks |

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
