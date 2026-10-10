# Operations — Field Survey server

Production (D67 option A): one DigitalOcean Basic Droplet, 2 vCPU / 4 GB (**currently 2 GB — resize before extraction/export jobs land, see TASKS follow-ups**), Ubuntu 24.04, running the Compose stack in `server/` (Caddy → api, worker, Postgres 16 in the named volume `pgdata`). Objects live in Cloudflare R2. Public name: `https://survey.wpcom.cloud`.

| Thing | Where |
|---|---|
| Droplet | DigitalOcean, `142.93.54.143`, Ubuntu 24.04, SSH as `root` with `~/.ssh/field_survey_droplet` on Landry's PC (deploy key, no passphrase; added to `/root/.ssh/authorized_keys`) |
| Checkout | `/opt/field-survey` (git clone over a read-only GitHub deploy key) |
| Config | `/opt/field-survey/server/.env` (master copy: `server/.env.production` on Landry's PC, never committed) |
| DNS | Cloudflare zone `wpcom.cloud`: `A survey → 142.93.54.143`, **DNS only** (grey cloud), so Caddy can get and renew its Let's Encrypt certificate itself |
| Objects | R2 bucket from `S3_BUCKET`, endpoint `https://<account-id>.r2.cloudflarestorage.com` |
| TLS | Caddy, automatic; certificates in the `caddy_data` volume |

`.env` sets `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`, so on the Droplet a plain `docker compose …` already uses the production override: no MinIO, Postgres not published to the host, `restart: unless-stopped`, logs capped at 5 × 10 MB per container.

Every command below runs on the Droplet in `/opt/field-survey/server` unless it says "on the PC".

## 1. Provision (once)

1. **Droplet.** Basic, Regular, 2 vCPU / 4 GB, Ubuntu 24.04 LTS, the team SSH key added. Paid Droplet backups off (D67: backups go to R2, T06).
2. **DNS.** In Cloudflare, add `A survey 142.93.54.143` with the proxy **off** (grey cloud). Check from the PC: `nslookup survey.wpcom.cloud 1.1.1.1`.
3. **R2.** In Cloudflare → R2, create an API token with *Object Read & Write* scoped to the bucket. Put the account id, bucket, access key id and secret into `server/.env.production` on the PC.
4. **Base setup** (swap, Docker, firewall, unattended upgrades). On the PC:
   ```
   scp -i ~/.ssh/field_survey_droplet server/deploy/provision.sh root@142.93.54.143:/root/
   ssh -i ~/.ssh/field_survey_droplet root@142.93.54.143 bash /root/provision.sh
   ```
   The script is idempotent. It adds a 2 GB `/swapfile` (swappiness 10), installs Docker Engine and the compose plugin, and opens only 22/80/443 in `ufw`.
5. **Checkout.** *(Until the GitHub deploy key is set up — T05 follow-up — the first deploy copied `server/` with `tar … | ssh … tar -x` into `/opt/field-survey/server`; converting it to a clone is this step plus `cp` of `.env` into the clone.)* On the Droplet: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy`. Add the public key as a read-only deploy key (on the PC: `gh repo deploy-key add <pubkey-file> --title droplet`). Then add `Host github.com` / `IdentityFile ~/.ssh/github_deploy` to `~/.ssh/config` and run `git clone git@github.com:WPCom100/field-survey.git /opt/field-survey`.
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
   curl https://survey.wpcom.cloud/health                       # {"status":"ok"}
   curl -H "Authorization: Bearer <SURVEY_SHARED_TOKEN>" https://survey.wpcom.cloud/team
   ```
   In the app: first launch asks for the server URL (`https://survey.wpcom.cloud`) and the shared token, then shows the team picker (Landry, Zach, Wiley).

## 2. Update

```
cd /opt/field-survey && git pull
cd server
docker compose up -d --build
docker compose run --rm api alembic upgrade head    # only when the pull brought a migration
docker compose ps && curl -s https://survey.wpcom.cloud/health
```

Migrations are applied by hand, so a bad one never starts on its own. Before any migration, take a dump (§3.1). Roll back with `git checkout <previous-sha>` and `docker compose up -d --build`. If the migration already ran, also run `alembic downgrade -1` before the rebuild.

Changing `.env`: edit the master copy on the PC, `scp` it as in §1.6, then `docker compose up -d` (containers whose env changed are recreated).

## 3. Backup and restore

The automated nightly `pg_dump` to R2 (90-day lifecycle) and the weekly copy to a second bucket arrive with T06. Until then, take dumps by hand before every migration.

### 3.1 Dump

```
docker compose exec -T postgres pg_dump -U survey -Fc survey > /root/survey-$(date +%F-%H%M).dump
```

### 3.2 Restore

1. Stop writers: `docker compose stop api worker`.
2. Restore into a scratch database first and look at it:
   ```
   docker compose exec -T postgres createdb -U survey survey_restore
   docker compose exec -T postgres pg_restore -U survey -d survey_restore --no-owner < /root/survey-<stamp>.dump
   docker compose exec postgres psql -U survey -d survey_restore -c "select count(*) from op"
   ```
3. Swap it in:
   ```
   docker compose exec postgres psql -U survey -d postgres -c "alter database survey rename to survey_old"
   docker compose exec postgres psql -U survey -d postgres -c "alter database survey_restore rename to survey"
   docker compose start api worker
   ```
4. Once the app checks out, `drop database survey_old`.

R2 objects are content-addressed and never overwritten (A14), so restoring the database never needs a matching object restore. Rows may point at blobs that were uploaded after the dump. The iPads still hold those and re-sync them.

### 3.3 Lost Droplet

Create a new Droplet, follow §1, restore the latest dump (§3.2, step 2 straight into `survey`), then point DNS at the new IP. The iPads keep their outboxes and push again once the server answers.

### 3.4 Resize the Droplet

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
