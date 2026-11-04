#!/usr/bin/env bash
# The Mac test rig (T149, D248; docs/ops.md §6).
#
# Runs on the one Mac: boots an iPad simulator, runs the e2e server in Docker, builds a local
# dev client with `expo run:ios`, starts Metro and runs the Maestro flows in app/maestro/.
# Nothing here ships: iPads only ever get EAS builds (D70). eas.json is never touched (D249).
# macOS bash is 3.2: no associative arrays, no ${var,,}.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SIM_A="${RIG_SIM_A:-Field Survey iPad}"
SIM_B="${RIG_SIM_B:-Field Survey iPad B}"
SERVER_URL="${RIG_SERVER_URL:-http://127.0.0.1:8010}"
TOKEN="${RIG_TOKEN:-e2e}"
METRO_URL="${RIG_METRO_URL:-http://127.0.0.1:8081}"
USER_NAME="${RIG_USER:-Ann}"
PROJECT="${RIG_PROJECT:-Maestro $(date +"%m-%d %H:%M:%S")}"   # one name per rig.sh run: A and B open the same project
SEED_PROJECT="${RIG_SEED_PROJECT:-Maestro master}"           # the checklist's "Tower round project" (T154)
PIPELINE_PROJECT="${RIG_PIPELINE_PROJECT:-Maestro pipeline}" # the checklist's "pipeline test" (T154)
SCALE_PROJECT="${RIG_SCALE_PROJECT:-Maestro scale}"          # TP-3 synthetic (T32, T154)
SIDE=""                                                      # A or B in a conflict run; flows read ${SIDE}
BUNDLE="productions.luminarytechnology.fieldsurvey"
COMPOSE="docker compose -f $ROOT/server/docker-compose.yml -f $ROOT/server/docker-compose.e2e.yml"
OUT="${TMPDIR:-/tmp}/field-survey-rig"
mkdir -p "$OUT"

say() { printf '\033[1mrig:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mrig:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
usage: bash scripts/mac/rig.sh <command>

  setup                 once: Xcode command-line tools check, Maestro, CocoaPods, pnpm install,
                        create and boot the simulator "$SIM_A"
  server [stop|start|reset]
                        e2e server in Docker on $SERVER_URL (token $TOKEN, team Ann/Bob);
                        stop = the app is offline; start = back online; reset = wipe its data
  build [--release]     local dev client for the simulator via expo run:ios (first run: prebuild,
                        pod install, the Xcode build; 10-20 min). --release embeds the JS instead
                        of loading it from Metro
  metro                 Metro for the dev client, in its own terminal
  open [A|B]            load the app from Metro on that simulator (the dev-client deep link)
  flows [--device A|B] [flow.yaml]
                        maestro test app/maestro (smoke.yaml unless a flow is named)
  second                boot "$SIM_B" with the same build (two-iPad checks)
  two                   setup.yaml on A (Ann), peer.yaml on B (Bob), peer-back.yaml on A: one project,
                        one edit each way
  files [A|B] <file>... put exactly these files in the Files app's "On My iPad" (document pickers)
  shot [A|B] [file]     screenshot of a simulator (default $OUT/shot-<time>.png)
  status                what is booted, built and running

  seed [--device A|B]   seed.yaml: the master workbook into "$SEED_PROJECT" through the app, the
                        standard vocabulary, the import's review items; once per server lifetime
                        (skipped when the server has the project; 'server reset' clears it)
  pipeline [--device A|B]
                        pipeline.yaml: "$PIPELINE_PROJECT" (B2-06M) with BOM.pdf, riser.pdf and the
                        06M sheet extracted; once per server lifetime like seed
  scale [synthetic args]
                        the TP-3 synthetic project "$SCALE_PROJECT" on the local server (T32; 2,000
                        devices, 10,000 photos by default; e.g. --photos 1000); once per server lifetime
  media [A|B]           two PNGs in the simulator's photo library (Library on the card, + Photo here)
  log [A|B] [grep-regex]
                        copy the app's log files out of the simulator's sandbox; prints the app.log
                        path, or the matching lines of every log file with a regex
  conflict <edit-flow> [check-flow]
                        on RIG_PROJECT, already on both simulators: server stop, <edit-flow> on A
                        (Ann, SIDE=A) and on B (Bob, SIDE=B), server start, A syncs then B syncs
                        (sync-now.yaml), then [check-flow] on A and on B

env: RIG_SERVER_URL RIG_TOKEN RIG_METRO_URL RIG_USER RIG_PROJECT RIG_SIM_A RIG_SIM_B
     RIG_SEED_PROJECT RIG_PIPELINE_PROJECT RIG_SCALE_PROJECT
EOF
}

# ---------------------------------------------------------------- simulators
sim_udid() {  # name -> udid (empty when it does not exist)
  xcrun simctl list devices -j | python3 -c '
import json, sys
name = sys.argv[1]
for rows in json.load(sys.stdin)["devices"].values():
    for d in rows:
        if d["name"] == name and d.get("isAvailable", True):
            print(d["udid"]); sys.exit()
' "$1"
}

pick_devicetype() {
  xcrun simctl list devicetypes -j | python3 -c '
import json, sys
types = [t for t in json.load(sys.stdin)["devicetypes"] if t["productFamily"] == "iPad"]
pro13 = [t for t in types if "iPad Pro 13-inch" in t["name"]]
pro129 = [t for t in types if "12.9-inch" in t["name"]]
t = (pro13 or pro129 or types)[-1]
print(t["identifier"])
'
}

pick_runtime() {
  xcrun simctl list runtimes -j | python3 -c '
import json, sys
rt = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r.get("isAvailable")]
if not rt:
    sys.exit("no iOS simulator runtime: open Xcode -> Settings -> Components and install one")
rt.sort(key=lambda r: [int(x) for x in r["version"].split(".")])
print(rt[-1]["identifier"])
'
}

ensure_sim() {  # name -> prints udid, creating and booting as needed
  local name="$1" udid
  udid="$(sim_udid "$name")"
  if [ -z "$udid" ]; then
    say "creating simulator \"$name\"" >&2
    udid="$(xcrun simctl create "$name" "$(pick_devicetype)" "$(pick_runtime)")"
  fi
  if [ "$(xcrun simctl list devices -j | python3 -c '
import json, sys
u = sys.argv[1]
for rows in json.load(sys.stdin)["devices"].values():
    for d in rows:
        if d["udid"] == u: print(d["state"])
' "$udid")" != "Booted" ]; then
    say "booting \"$name\"" >&2
    xcrun simctl boot "$udid"
  fi
  open -a Simulator --args -CurrentDeviceUDID "$udid" >/dev/null 2>&1 || true
  echo "$udid"
}

sim_for() {  # A|B -> udid
  case "${1:-A}" in
    A|a) ensure_sim "$SIM_A" ;;
    B|b) ensure_sim "$SIM_B" ;;
    *) die "device must be A or B" ;;
  esac
}

built_app() {  # path of the last local build (Debug or Release); fails when there is none
  # expo run:ios builds into Xcode's DerivedData, not app/ios/build (T151)
  { find "$ROOT/app/ios/build/Build/Products" -maxdepth 2 -name '*.app' -type d 2>/dev/null || true
    ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/FieldSurvey-*/Build/Products/*-iphonesimulator/FieldSurvey.app 2>/dev/null || true
  } | head -1 | grep .
}

# ---------------------------------------------------------------- commands
cmd_setup() {
  [ "$(uname)" = Darwin ] || die "this runs on the Mac only"
  xcode-select -p >/dev/null 2>&1 || die "Xcode is not installed: App Store -> Xcode, open it once, then: sudo xcodebuild -license accept"
  xcrun simctl list runtimes >/dev/null 2>&1 || die "xcrun simctl failed: open Xcode once and accept the licence (sudo xcodebuild -license accept)"
  command -v brew >/dev/null || die "Homebrew is missing: https://brew.sh then rerun"
  command -v node >/dev/null || die "Node is missing: brew install node@24 (then add it to PATH) and rerun"
  case "$(node -v)" in v24.*) ;; *) say "warning: Node $(node -v); the PC runs Node 24" ;; esac
  command -v pnpm >/dev/null || { say "installing pnpm"; npm install -g pnpm; }
  command -v pod >/dev/null || { say "installing CocoaPods"; brew install cocoapods; }
  command -v maestro >/dev/null || { say "installing Maestro"; curl -Ls "https://get.maestro.mobile.dev" | bash; export PATH="$HOME/.maestro/bin:$PATH"; }
  command -v maestro >/dev/null || die "Maestro installed but not on PATH: add \$HOME/.maestro/bin to PATH and rerun"
  docker info >/dev/null 2>&1 || say "warning: Docker is not running (Docker Desktop or OrbStack); 'rig.sh server' needs it"
  say "pnpm install"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  ensure_sim "$SIM_A" >/dev/null
  say "ready"
}

cmd_server() {
  cd "$ROOT/server"
  case "${1:-up}" in
    up)
      [ -f .env ] || cp .env.example .env
      # the worker (upload jobs, T151) starts after the migration: on a fresh database it dies on
      # the first missing table (T154, after a reset)
      $COMPOSE up -d --build postgres s3 api
      # a fresh volume runs initdb first: migrating before Postgres accepts connections fails (T151);
      # after a reset initdb once took longer than 60 s (T154)
      for _ in $(seq 1 120); do $COMPOSE exec -T postgres pg_isready -q && break; sleep 1; done
      $COMPOSE exec -T postgres pg_isready -q || die "Postgres did not become ready within 120 s: $COMPOSE logs postgres"
      $COMPOSE exec -T api alembic upgrade head
      # a fresh s3 volume starts slower than the api: retry until it answers (T154, after a reset)
      for _ in $(seq 1 30); do
        $COMPOSE exec -T api python -m app.storage ensure-bucket >/dev/null 2>&1 && break
        sleep 1
      done
      $COMPOSE exec -T api python -m app.storage ensure-bucket || die "the bucket could not be made: $COMPOSE logs s3"
      $COMPOSE up -d --build worker
      for _ in $(seq 1 30); do
        if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then say "health: ok ($SERVER_URL)"; return; fi
        sleep 1
      done
      die "the API did not answer on $SERVER_URL/health within 30 s: $COMPOSE logs api"
      ;;
    stop) $COMPOSE stop api; say "api stopped: the app is offline now" ;;
    start) $COMPOSE start api; say "api started" ;;
    reset)
      $COMPOSE down -v
      # the keychain keeps each simulator's user id from the old server, which the new one does
      # not know: every push is refused "unknown user" until the app signs in again (T154)
      for sim in "$SIM_A" "$SIM_B"; do
        u="$(sim_udid "$sim")"
        [ -n "$u" ] && xcrun simctl keychain "$u" reset && say "keychain reset on \"$sim\""
      done
      say "server data wiped; run 'rig.sh server' again" ;;
    *) die "server [stop|start|reset]" ;;
  esac
}

cmd_build() {
  local udid cfg=Debug
  udid="$(sim_for A)"
  [ "${1:-}" = "--release" ] && cfg=Release
  cd "$ROOT/app"
  say "expo run:ios ($cfg) on \"$SIM_A\" — the first run prebuilds ios/ and runs pod install"
  npx expo run:ios --device "$udid" --no-bundler --configuration "$cfg"
  say "installed: $(built_app)"
}

cmd_metro() {
  cd "$ROOT/app"
  say "Metro on $METRO_URL; leave this terminal open"
  npx expo start --dev-client --port "${METRO_URL##*:}"
}

cmd_open() {
  local udid
  udid="$(sim_for "${1:-A}")"
  xcrun simctl launch "$udid" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl openurl "$udid" "fieldsurvey://expo-development-client/?url=$METRO_URL"
  say "opened the dev client on ${1:-A} from $METRO_URL"
}

cmd_flows() {
  local dev=A flow="" udid
  while [ $# -gt 0 ]; do
    case "$1" in
      --device) dev="$2"; shift 2 ;;
      *) flow="$1"; shift ;;
    esac
  done
  # flows that upload (Setup → Sources) pick these from the Files app by position (T151)
  if grep -q "_sources.yaml" "$ROOT/app/maestro/${flow:-smoke.yaml}" 2>/dev/null; then
    cmd_files "$dev" fixtures/DaVinci_categories.xlsx fixtures/davinci-library-sample.json \
      "fixtures/Level_06M_-_Lighting_Composite_vector.pdf"
  fi
  udid="$(sim_for "$dev")"
  command -v maestro >/dev/null || export PATH="$HOME/.maestro/bin:$PATH"
  command -v java >/dev/null || die "Maestro needs Java 17+: brew install openjdk@17 and set JAVA_HOME (docs/ops.md §6.1)"
  say "maestro on $dev ($udid): ${flow:-smoke.yaml} against $SERVER_URL as $USER_NAME, project \"$PROJECT\""
  maestro --device "$udid" test \
    -e SERVER_URL="$SERVER_URL" -e TOKEN="$TOKEN" -e METRO_URL="$METRO_URL" -e USER="$USER_NAME" \
    -e PROJECT="$PROJECT" -e SIDE="${SIDE:-$dev}" \
    --debug-output "$OUT/maestro" \
    "$ROOT/app/maestro/${flow:-smoke.yaml}"   # the folder would also run the _ sub-flows on their own (T151)
  say "screenshots of failures: $OUT/maestro and ~/.maestro/tests"
}

cmd_second() {
  local app udid
  app="$(built_app)"
  [ -n "$app" ] || die "no local build yet: rig.sh build"
  udid="$(sim_for B)"
  xcrun simctl install "$udid" "$app"
  say "\"$SIM_B\" booted with $app; 'rig.sh open B' loads it from Metro, 'rig.sh flows --device B' runs the flows there"
}

cmd_two() {  # one edit each way between two simulators, on one project (T151)
  cmd_second
  say "two simulators on \"$PROJECT\": A (Ann) sets it up and edits, B (Bob) sees it and edits, A sees B's"
  USER_NAME=Ann cmd_flows --device A setup.yaml
  USER_NAME=Bob cmd_flows --device B peer.yaml
  USER_NAME=Ann cmd_flows --device A peer-back.yaml
  say "two: green"
}

cmd_files() {  # [A|B] file... -> the Files app's "On My iPad" on that simulator (document pickers, T151)
  local dev=A udid group dest f
  case "${1:-}" in A|a|B|b) dev="$1"; shift ;; esac
  [ $# -gt 0 ] || die "files [A|B] <file>...: e.g. files fixtures/davinci-library-sample.json"
  udid="$(sim_for "$dev")"
  group="$(xcrun simctl get_app_container "$udid" com.apple.DocumentsApp groups 2>/dev/null \
    | awk '$1 == "group.com.apple.FileProvider.LocalStorage" { print $2 }')"
  if [ -z "$group" ]; then  # older runtimes: find the group by its container metadata
    for g in "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Containers/Shared/AppGroup"/*; do
      [ "$(plutil -extract MCMMetadataIdentifier raw "$g/.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null)" = group.com.apple.FileProvider.LocalStorage ] && group="$g"
    done
  fi
  [ -n "$group" ] || die "no Files app storage on $dev yet: open the Files app on it once"
  dest="$group/File Provider Storage"
  # replace, not add: flows tap the picker by position, so the folder holds exactly these files
  rm -rf "$dest"; mkdir -p "$dest"
  for f in "$@"; do
    case "$f" in /*) ;; *) f="$ROOT/$f" ;; esac
    [ -f "$f" ] || die "no such file: $f"
    cp "$f" "$dest/"
    say "On My iPad ($dev): $(basename "$f")"
  done
}

cmd_shot() {
  local udid file
  udid="$(sim_for "${1:-A}")"
  file="${2:-$OUT/shot-$(date +%H%M%S).png}"
  xcrun simctl io "$udid" screenshot "$file" >/dev/null
  echo "$file"
}

# ---------------------------------------------------------------- rig plan §2 (T154)
server_up() {
  curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 || die "the server does not answer on $SERVER_URL: rig.sh server"
}

project_levels() {  # name -> its level count on the local server, or -1 when there is no such project
  curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER_URL/projects" | python3 -c '
import json, sys
found = [p for p in json.load(sys.stdin) if p["name"] == sys.argv[1]]
print(len(found[0]["levels"]) if found else -1)
' "$1"
}

project_exists() {  # name -> 0 when the local server has a project of that name
  [ "$(project_levels "$1")" -ge 0 ]
}

made_once() {  # name, levels it has when made -> 0 when made (skip), 1 when absent; dies on a half-made one
  local n
  n="$(project_levels "$1")"
  [ "$n" -lt 0 ] && return 1
  [ "$n" -ge "$2" ] && return 0
  die "\"$1\" is on the server with $n of its $2 levels: a run stopped half-way. 'rig.sh server reset' (wipes the rig server), or name another with RIG_SEED_PROJECT / RIG_PIPELINE_PROJECT"
}

device_arg() {  # [--device A|B] -> A|B
  if [ "${1:-}" = "--device" ]; then echo "${2:-A}"; else echo A; fi
}

cmd_seed() {  # the master workbook into SEED_PROJECT, through the app (seed.yaml)
  local dev
  dev="$(device_arg "$@")"
  server_up
  if made_once "$SEED_PROJECT" 8; then   # the import adds B2 … 06 to the 06M it starts with
    say "\"$SEED_PROJECT\" is on the server already: skipped ('server reset' clears it)"
    return
  fi
  cmd_files "$dev" fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx
  PROJECT="$SEED_PROJECT" cmd_flows --device "$dev" seed.yaml
  made_once "$SEED_PROJECT" 8 || die "seed.yaml ran but the server has no \"$SEED_PROJECT\""
  say "seed: \"$SEED_PROJECT\" imported"
}

cmd_pipeline() {  # PIPELINE_PROJECT with the BOM, the riser and the 06M sheet (pipeline.yaml)
  local dev
  dev="$(device_arg "$@")"
  server_up
  if made_once "$PIPELINE_PROJECT" 8; then
    say "\"$PIPELINE_PROJECT\" is on the server already: skipped ('server reset' clears it)"
    return
  fi
  # pipeline.yaml taps them by position: BOM.pdf, Level_06M_…, riser.pdf (name order)
  cmd_files "$dev" fixtures/BOM.pdf "fixtures/Level_06M_-_Lighting_Composite_vector.pdf" fixtures/riser.pdf
  PROJECT="$PIPELINE_PROJECT" cmd_flows --device "$dev" pipeline.yaml
  say "pipeline: \"$PIPELINE_PROJECT\" ready"
}

cmd_scale() {  # the TP-3 synthetic project on the local server (T32); extra args go to the generator
  server_up
  if project_exists "$SCALE_PROJECT"; then
    say "\"$SCALE_PROJECT\" is on the server already: skipped ('server reset' clears it)"
    return
  fi
  cd "$ROOT/server"
  # the image has no fixtures/: the generator's sheet goes in by hand
  $COMPOSE cp "$ROOT/fixtures/Level_06M_-_Lighting_Composite_vector.pdf" api:/tmp/06M.pdf
  say "generating \"$SCALE_PROJECT\" (several minutes at the default size)"
  $COMPOSE exec -T api python -m app.jobs.synthetic --name "$SCALE_PROJECT" --users Ann,Bob \
    --sheet /tmp/06M.pdf "$@"
  say "scale: \"$SCALE_PROJECT\" on the server; an iPad gets it with Projects → Refresh"
}

cmd_media() {  # two PNGs in the photo library (the simulator has no camera)
  local udid dir="$OUT/media"
  udid="$(sim_for "${1:-A}")"
  mkdir -p "$dir"
  python3 - "$dir" <<'PY'
import struct, sys, zlib
def png(path, rgb, w=640, h=480):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)
png(sys.argv[1] + "/rig-photo-1.png", (200, 40, 40))
png(sys.argv[1] + "/rig-photo-2.png", (40, 90, 200))
PY
  xcrun simctl addmedia "$udid" "$dir/rig-photo-1.png" "$dir/rig-photo-2.png"
  say "photo library (${1:-A}): rig-photo-1.png (red), rig-photo-2.png (blue)"
}

cmd_log() {  # [A|B] [regex]: the app's log files (Documents/logs, app/src/log) copied out
  local dev=A udid data dest
  case "${1:-}" in A|a|B|b) dev="$1"; shift ;; esac
  udid="$(sim_for "$dev")"
  data="$(xcrun simctl get_app_container "$udid" "$BUNDLE" data 2>/dev/null)" || die "the app is not installed on $dev"
  [ -d "$data/Documents/logs" ] || die "no log folder yet on $dev: launch the app once"
  dest="$OUT/log-$dev"
  rm -rf "$dest"; mkdir -p "$dest"
  cp "$data"/Documents/logs/*.log "$dest/" 2>/dev/null || die "no log files on $dev yet"
  if [ $# -gt 0 ]; then
    grep -hE "$1" "$dest"/*.log || die "no log line on $dev matches: $1"
  else
    echo "$dest/app.log"
  fi
}

cmd_conflict() {  # <edit-flow> [check-flow]: both iPads edit offline, then both sync (rig plan O2)
  local edit="${1:-}" check="${2:-}"
  [ -n "$edit" ] || die "conflict <edit-flow> [check-flow]: the edit flow resumes the app (no clearState) and edits without syncing"
  [ -n "${RIG_PROJECT:-}" ] || die "conflict needs RIG_PROJECT: a project already on both simulators (e.g. after 'RIG_PROJECT=… rig.sh two')"
  server_up
  say "conflict on \"$PROJECT\": $edit offline on A (Ann) and B (Bob), then A syncs, then B"
  cmd_server stop
  # whatever happens, the server comes back: a stopped api leaves every later run offline
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  USER_NAME=Ann SIDE=A cmd_flows --device A "$edit"
  USER_NAME=Bob SIDE=B cmd_flows --device B "$edit"
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 30); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  server_up
  USER_NAME=Ann SIDE=A cmd_flows --device A sync-now.yaml
  USER_NAME=Bob SIDE=B cmd_flows --device B sync-now.yaml
  if [ -n "$check" ]; then
    USER_NAME=Ann SIDE=A cmd_flows --device A "$check"
    USER_NAME=Bob SIDE=B cmd_flows --device B "$check"
  fi
  say "conflict: green"
}

cmd_status() {
  say "simulators:"; xcrun simctl list devices | grep -E "$SIM_A|$SIM_B" || echo "  none"
  say "build: $(built_app || echo none)"
  say "server: $(curl -fsS "$SERVER_URL/health" 2>/dev/null || echo "not answering on $SERVER_URL")"
  say "metro: $(curl -fsS "$METRO_URL/status" 2>/dev/null || echo "not running on $METRO_URL")"
}

case "${1:-}" in
  setup) cmd_setup ;;
  server) shift; cmd_server "$@" ;;
  build) shift; cmd_build "$@" ;;
  metro) cmd_metro ;;
  open) shift; cmd_open "$@" ;;
  flows) shift; cmd_flows "$@" ;;
  second) cmd_second ;;
  two) cmd_two ;;
  files) shift; cmd_files "$@" ;;
  shot) shift; cmd_shot "$@" ;;
  status) cmd_status ;;
  seed) shift; cmd_seed "$@" ;;
  pipeline) shift; cmd_pipeline "$@" ;;
  scale) shift; cmd_scale "$@" ;;
  media) shift; cmd_media "$@" ;;
  log) shift; cmd_log "$@" ;;
  conflict) shift; cmd_conflict "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage; die "unknown command: $1" ;;
esac
