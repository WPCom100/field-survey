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
  place-two             F4 two-iPad half: place-two-setup.yaml on A, place-two-peer.yaml on B, then
                        conflict place-two-edit.yaml place-two-check.yaml (one unit each, offline)
  offline [setup edit check [entity:field ...]]
                        O1 (T156): setup on A online, server stop, edit, server start, check; then the
                        server must hold an applied op of each entity:field made while it was stopped
                        (default offline-setup/-edit/-check.yaml and every kind of edit O1 makes)
  conflicts             O2 (T156): offline-setup.yaml on A, conflicts-peer.yaml on B, then conflict
                        conflicts-edit.yaml conflicts-check.yaml (a status, a ruling against a hand
                        note, an app-library type; A resolves each with Choose B)
  same-user             O3 (T156): A and B both as Ann; same-user-setup.yaml, -peer.yaml, then conflict
                        same-user-edit.yaml same-user-check.yaml with RIG_PEER=Ann; A's log must read
                        ink_merged (both strokes kept)
  resume                O4 (T156): media on A, then offline resume-setup.yaml resume-edit.yaml
                        resume-check.yaml (a kill and a re-sign-in before the sync keep the edits)
  review                R5 (T157): station-setup.yaml on A, same-user-peer.yaml on B (Bob), then conflict
                        review-edit.yaml review-check.yaml (two notes offline, Save combined on A)
  export                R6 (T157): offline station-setup.yaml export-edit.yaml export-check.yaml
                        device:status (the gate offline, then a workbook and a floor PDF to Ready)
  projects              R7 (T157): projects.yaml on A, then projects-offline.yaml with the server stopped
  photos                F5 (T158): media on A, photos.yaml, then the server holds each photo once, uploaded whole
  drafts [--device A|B] S2 (T158): drafts.yaml (its own pipeline project, then the riser drafts), then the
                        server holds the confirm whose reason names the drafts by model
  lock                  S3 (T158): lock.yaml on A (Ann), lock-peer.yaml on B (Bob), lock-check.yaml on A
  ink                   F6 (T158): ink-setup.yaml on A (Ann), ink-peer.yaml on B (Bob), ink-check.yaml on A; each
                        sees the other's stroke in its log (ink_loaded)
  library-two           S4 (T158): library-two.yaml on A (Ann: a type, its card, kits, a pin shape, an app-library
                        type), library-two-peer.yaml on B (Bob sees each and puts the app-wide ones back)
  sheets                S5 (T158): sheets-old.yaml on A with a generated older DaVinci_categories.xlsx (ERn →
                        Equipment), sheets-new.yaml with the current one; the server's two batches each
                        corrected the ERn category and no Neuron flag. Alone: the app library is server-wide
  pickup                O5 (T159): pickup-setup.yaml on A (Ann: a card left open), pickup-peer.yaml on B (Bob
                        sets its status), pickup-card.yaml on A (follows, no Sync now), pickup-alias.yaml on B
                        (ROUND=1) and pickup-form.yaml on A (the open library form follows); then A scrolls
                        Levels (pickup-scroll.yaml) while B saves three fields (ROUND=3): A's log has one
                        3-op pull and one rules run per project after it, none for the library stream
  scale-check           W5 (T159): scale.yaml (a fresh store on A downloads "$SCALE_PROJECT", the quiet timing
                        line, its 06M plan) and scale-demo.yaml (500 pins); the log's numbers against
                        scripts/mac/scale-ceilings.txt (docs/perf/rig.md). Run 'scale' first; reset after
  restart               O6 (T159): with the api stopped A generates ~1,500 punch items on "$SCALE_PROJECT"
                        (restart-edit.yaml); the api is started and restarted mid-push; then nothing refused
                        (restart-check.yaml, the server's op states) and each numbering group continues
  stranger              T160: smoke.yaml on A (Ann), stranger-signin.yaml (a fresh name); with the api
                        stopped that name's app_user row is deleted (an old backup) and stranger-edit.yaml
                        queues an edit; stranger-check.yaml: the Sync screen names the lost user, Re-sign in
                        carries the edit over to the name's new id, and the server has it under that name

env: RIG_SERVER_URL RIG_TOKEN RIG_METRO_URL RIG_USER RIG_PROJECT RIG_SIM_A RIG_SIM_B
     RIG_SEED_PROJECT RIG_PIPELINE_PROJECT RIG_SCALE_PROJECT
     RIG_PICKER=old|new (the Files picker's tap spots; default by the simulator's iOS: 26+ new)
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

sim_ios_major() {  # udid -> the major iOS version of its runtime (e.g. 26)
  xcrun simctl list devices -j | python3 -c '
import json, re, sys
u = sys.argv[1]
for rt, rows in json.load(sys.stdin)["devices"].items():
    for d in rows:
        if d["udid"] == u:
            m = re.search(r"iOS-(\d+)", rt)
            print(m.group(1) if m else 0); sys.exit()
print(0)
' "$1"
}

picker_env() {  # udid -> "K=v ..." the Files picker's spots for the flows (T168)
  # The picker is another process (Maestro sees none of it), so flows tap it by position, in whole
  # screen percentages on the iPad Pro 13" simulator in portrait: PICK_SIDE = the sidebar's "On My
  # iPad", PICK_1..3 = the folder's files in name order, PICK_OPEN = Open (multiple selection).
  # PICK_PHOTO: the photo picker's first photo (`rig.sh media` adds two).
  # iOS 26 shows a floating sheet over the lower middle; older runtimes a wider one higher up
  # (measured on the first rig's pre-26 runtime, T151). RIG_PICKER=old|new overrides the runtime's choice.
  local set="${RIG_PICKER:-}"
  if [ -z "$set" ]; then
    if [ "$(sim_ios_major "$1")" -ge 26 ]; then set=new; else set=old; fi
  fi
  case "$set" in
    new) echo "PICKER=new PICK_SIDE=25%,47% PICK_1=51%,35% PICK_2=66%,35% PICK_3=80%,35% PICK_OPEN=84%,29% PICK_PHOTO=45%,35%" ;;
    old) echo "PICKER=old PICK_SIDE=14%,46% PICK_1=41%,35% PICK_2=53%,35% PICK_3=65%,35% PICK_OPEN=92%,28% PICK_PHOTO=39%,35%" ;;
    *) die "RIG_PICKER must be old or new" ;;
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
  docker info >/dev/null 2>&1 || say "warning: Docker is not running (colima start, Docker Desktop or OrbStack); 'rig.sh server' needs it"
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
  # EXPO_PUBLIC_RIG=1: the app keeps the dev client's error toasts off the screen (they took
  # Maestro's taps, T161, T156); EXPO_PUBLIC_* is inlined at bundle time, so --clear when it changes
  EXPO_PUBLIC_RIG=1 npx expo start --dev-client --port "${METRO_URL##*:}" "$@"
}

cmd_open() {
  local udid
  udid="$(sim_for "${1:-A}")"
  xcrun simctl launch "$udid" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl openurl "$udid" "fieldsurvey://expo-development-client/?url=$METRO_URL"
  say "opened the dev client on ${1:-A} from $METRO_URL"
}

uses_sources() {  # flow -> 0 when it, or a sub-flow it runs, uploads through _sources.yaml (T156: _sheet-station)
  local f="$ROOT/app/maestro/$1" sub
  grep -q "_sources.yaml" "$f" 2>/dev/null && return 0
  # no pipeline into grep -q here: under pipefail its early exit fails the whole test
  for sub in $(grep -o '_[a-z-]*.yaml' "$f" 2>/dev/null | sort -u); do
    grep -q "_sources.yaml" "$ROOT/app/maestro/$sub" 2>/dev/null && return 0
  done
  return 1
}

cmd_flows() {
  local dev=A flow="" udid
  while [ $# -gt 0 ]; do
    case "$1" in
      --device) dev="$2"; shift 2 ;;
      *) flow="$1"; shift ;;
    esac
  done
  # flows that upload (Setup → Sources) pick these from the Files app by position (T151); also
  # through one of their sub-flows (_sheet-station.yaml, T156)
  # (RIG_KEEP_FILES=1: the caller staged its own, e.g. `rig.sh sheets`' generated DaVinci pair)
  if [ -z "${RIG_KEEP_FILES:-}" ] && uses_sources "${flow:-smoke.yaml}"; then
    cmd_files "$dev" fixtures/DaVinci_categories.xlsx fixtures/davinci-library-sample.json \
      "fixtures/Level_06M_-_Lighting_Composite_vector.pdf"
  fi
  # flows that work on their own copy of the master (wave 1, T155) pick the workbook alone
  if grep -q "_seed-copy.yaml" "$ROOT/app/maestro/${flow:-smoke.yaml}" 2>/dev/null; then
    if grep -q "_sheet.yaml" "$ROOT/app/maestro/${flow:-smoke.yaml}"; then
      # ...and then the 06M sheet (place.yaml): by name the sheet is 1st, the workbook 2nd (SEED_AT)
      cmd_files "$dev" "fixtures/Level_06M_-_Lighting_Composite_vector.pdf" fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx
    else
      cmd_files "$dev" fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx
    fi
  fi
  # flows that make their own pipeline project first (drafts.yaml runs pipeline.yaml, T158): the
  # three files it taps by position, in name order
  if grep -q "runFlow: pipeline.yaml" "$ROOT/app/maestro/${flow:-smoke.yaml}" 2>/dev/null; then
    cmd_files "$dev" fixtures/BOM.pdf "fixtures/Level_06M_-_Lighting_Composite_vector.pdf" fixtures/riser.pdf
  fi
  udid="$(sim_for "$dev")"
  command -v maestro >/dev/null || export PATH="$HOME/.maestro/bin:$PATH"
  command -v java >/dev/null || die "Maestro needs Java 17+: brew install openjdk@17 and set JAVA_HOME (docs/ops.md §6.1)"
  local picks; picks="$(picker_env "$udid")"
  say "maestro on $dev ($udid): ${flow:-smoke.yaml} against $SERVER_URL as $USER_NAME, project \"$PROJECT\", picker ${picks%% *}"
  # RIG_ENV="K=v K2=v2": extra flow variables for one run (T159: ROUND); values have no spaces
  local extra=() kv
  for kv in $picks ${RIG_ENV:-}; do extra+=(-e "$kv"); done
  maestro --device "$udid" test \
    -e SERVER_URL="$SERVER_URL" -e TOKEN="$TOKEN" -e METRO_URL="$METRO_URL" -e USER="$USER_NAME" \
    -e PROJECT="$PROJECT" -e SIDE="${SIDE:-$dev}" -e SEED="$SEED_PROJECT" -e SCALE="$SCALE_PROJECT" \
    ${extra[@]+"${extra[@]}"} \
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
  local peer="${RIG_PEER:-Bob}"   # RIG_PEER=Ann: one user on both iPads (O3, D37)
  say "conflict on \"$PROJECT\": $edit offline on A (Ann) and B ($peer), then A syncs, then B"
  cmd_server stop
  # whatever happens, the server comes back: a stopped api leaves every later run offline
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  USER_NAME=Ann SIDE=A cmd_flows --device A "$edit"
  USER_NAME="$peer" SIDE=B cmd_flows --device B "$edit"
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 30); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  server_up
  USER_NAME=Ann SIDE=A cmd_flows --device A sync-now.yaml
  USER_NAME="$peer" SIDE=B cmd_flows --device B sync-now.yaml
  if [ -n "$check" ]; then
    USER_NAME=Ann SIDE=A cmd_flows --device A "$check"
    USER_NAME="$peer" SIDE=B cmd_flows --device B "$check"
  fi
  say "conflict: green"
}

server_ops() {  # project name, from, to (UTC) -> "<entity_kind>:<field or kind> <state> <count>" of the ops the server holds
  # the window is the ops' client_ts: the simulators share the Mac's clock (T156)
  printf "%s\n" "select o.entity_kind || ':' || coalesce(o.field, o.kind), o.state, count(*)
    from op o join project p on p.id = o.project_id
    where p.name = :'name' and o.client_ts >= :'t0' and o.client_ts <= :'t1'
    group by 1, 2 order by 1, 2;" \
  | $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F" " -v ON_ERROR_STOP=1 -v name="$1" -v t0="$2" -v t1="$3"' \
      psql "$1" "$2" "$3"
}

cmd_conflicts() {  # O2 (T156): a device field, a ruling against a hand edit and an app-library type, on two iPads offline
  cmd_second
  say "conflicts on \"$PROJECT\": A (Ann) makes a seed copy, B (Bob) opens it, both edit the same fields offline, A resolves"
  USER_NAME=Ann cmd_flows --device A offline-setup.yaml
  USER_NAME=Bob cmd_flows --device B conflicts-peer.yaml
  RIG_PROJECT="$PROJECT" cmd_conflict conflicts-edit.yaml conflicts-check.yaml
  say "conflicts: green"
}

cmd_same_user() {  # O3 (T156): one user on two iPads, the same field and the same ink layer offline
  cmd_second
  say "same-user on \"$PROJECT\": A and B both as Ann; one status and Ann's ink layer edited on both offline"
  USER_NAME=Ann cmd_flows --device A same-user-setup.yaml
  USER_NAME=Ann cmd_flows --device B same-user-peer.yaml
  RIG_PEER=Ann RIG_PROJECT="$PROJECT" cmd_conflict same-user-edit.yaml same-user-check.yaml
  say "ink merges in the app logs (A, then B):"
  ( cmd_log A 'ink_merged' ) || die "no ink_merged line on A: the two writes of Ann's layer were not merged"
  ( cmd_log B 'ink_merged' ) || say "(no merge line on B: A's merge reached it already merged)"
  say "same-user: green"
}

cmd_resume() {  # O4 (T156): edits and a photo survive a kill and a re-sign-in while offline, then drain
  cmd_media A
  cmd_offline resume-setup.yaml resume-edit.yaml resume-check.yaml device:status device:notes photo:create
  say "resume: green"
}

O1_EXPECT="device:status device:notes device:ip_address device:dmx_address cable_end:status punch_item:create missing_part:create cable:endpoint_confirmed finding:state level:state"

cmd_offline() {  # [setup edit check [entity:field ...]]: edits made with the server stopped drain when it is back (rig plan O1, O4)
  local setup="${1:-offline-setup.yaml}" edit="${2:-offline-edit.yaml}" check="${3:-offline-check.yaml}" t0 t1 ops want missing=""
  [ $# -ge 3 ] && shift 3 || set --
  want="${*:-$O1_EXPECT}"
  server_up
  say "offline on \"$PROJECT\": $setup online, $edit with the server stopped, $check once it is back"
  USER_NAME=Ann cmd_flows --device A "$setup"
  t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_server stop
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  USER_NAME=Ann cmd_flows --device A "$edit"
  t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 30); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  server_up
  USER_NAME=Ann cmd_flows --device A "$check"
  cd "$ROOT/server"
  ops="$(server_ops "$PROJECT" "$t0" "$t1")"
  say "the server's ops made between $t0 and $t1 (entity:field state count):"
  printf '%s\n' "$ops" | sed 's/^/  /'
  for w in $want; do
    printf '%s\n' "$ops" | grep -q "^$w applied " || missing="$missing $w"
  done
  [ -z "$missing" ] || die "made offline but not applied on the server:$missing"
  say "offline: green (every kind of edit drained: $want)"
}

cmd_place_two() {  # F4 two-iPad half (T46): one pooled draft, one unit placed on each iPad offline
  cmd_second
  say "place-two on \"$PROJECT\": A (Ann) pools a Station draft of two, B (Bob) opens the plan, both place one unit offline"
  USER_NAME=Ann cmd_flows --device A place-two-setup.yaml
  USER_NAME=Bob cmd_flows --device B place-two-peer.yaml
  RIG_PROJECT="$PROJECT" cmd_conflict place-two-edit.yaml place-two-check.yaml
  say "place-two: green"
}

cmd_projects() {  # R7 (T157): projects.yaml on A, then projects-offline.yaml with the server stopped
  server_up
  made_once "$SEED_PROJECT" 8 || die "no \"$SEED_PROJECT\" on the server: rig.sh seed first"
  say "projects on \"$PROJECT\": two projects on A, then a Create with the server stopped"
  USER_NAME=Ann cmd_flows --device A projects.yaml
  cmd_server stop
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  USER_NAME=Ann cmd_flows --device A projects-offline.yaml
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 30); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  say "projects: green"
}

cmd_review() {  # R5 (T157): one station project on A and B, two notes offline, Save combined on A
  cmd_second
  say "review on \"$PROJECT\": A (Ann) makes it, B (Bob) opens it, both type a note on 06M-S1 offline, A combines them"
  USER_NAME=Ann cmd_flows --device A station-setup.yaml
  USER_NAME=Bob cmd_flows --device B same-user-peer.yaml
  RIG_PROJECT="$PROJECT" cmd_conflict review-edit.yaml review-check.yaml
  say "review: green"
}

cmd_export() {  # R6 (T157): the export gate offline, then a workbook and a floor PDF to Ready
  RIG_PROJECT="$PROJECT" cmd_offline station-setup.yaml export-edit.yaml export-check.yaml device:status
  say "export: green"
}

server_sql() {  # project name, sql (reads :'name') -> rows, space-separated (T158)
  printf "%s\n" "$2" \
  | (cd "$ROOT/server" && $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F" " -v ON_ERROR_STOP=1 -v name="$1"' psql "$1")
}

cmd_photos() {  # F5 (T158): library photos, a kill while queued, a link, + Photo here; then each photo once on the server
  local rows
  server_up
  cmd_media A
  USER_NAME=Ann cmd_flows --device A photos.yaml
  # every photo once (a resumed upload must not make a second record), each with its image and
  # thumbnail uploaded whole, and the one link to 06M-S2
  rows="$(server_sql "$PROJECT" "select count(*), count(distinct ph.id),
      count(*) filter (where ph.device_id is null),
      count(*) filter (where bi.upload_state = 'complete' and bt.upload_state = 'complete'),
      (select count(*) from photo_link pl join photo p2 on p2.id = pl.photo_id join level l2 on l2.id = p2.level_id
         join project q on q.id = l2.project_id where q.name = :'name' and pl.target_kind = 'device' and pl.deleted_at is null)
    from photo ph join level l on l.id = ph.level_id join project p on p.id = l.project_id
    left join blob bi on bi.sha256 = ph.image_blob left join blob bt on bt.sha256 = ph.thumb_blob
    where p.name = :'name' and ph.deleted_at is null;")"
  say "server photos on \"$PROJECT\" (rows, distinct, level-only, uploaded whole, device links): $rows"
  [ "$rows" = "2 2 1 2 1" ] || die "expected 2 photos (one on the level only), both uploaded whole, one device link; got: $rows"
  say "photos: green"
}

cmd_drafts() {  # S2 (T158): drafts.yaml on its own pipeline project, then the confirm's reason on the server (T137)
  local n
  server_up
  cmd_flows --device "$(device_arg "$@")" drafts.yaml
  n="$(server_sql "$PROJECT" "select count(*) from op o join project p on p.id = o.project_id
    where p.name = :'name' and o.state = 'applied'
      and o.reason = 'Draft review: endpoint confirmed N ERN4-RM-120 Equipment Rack 18U (draft, 01) → P-NSPS-D (draft, 02)';")"
  say "applied ops whose reason names the drafts by model (T137): $n"
  [ "${n:-0}" -ge 1 ] || die "no applied op with the confirm's reason naming P-NSPS-D (draft, 02)"
  say "drafts: green"
}

cmd_lock() {  # S3 (T158): the Rules tab, a lock and an assignment on A; B sees them and unticks; A follows and unlocks
  cmd_second
  say "lock on \"$PROJECT\": A (Ann) changes rules, locks 06M, assigns 06 to Ann; B (Bob) sees it and unticks; A unlocks"
  USER_NAME=Ann cmd_flows --device A lock.yaml
  USER_NAME=Bob cmd_flows --device B lock-peer.yaml
  USER_NAME=Ann cmd_flows --device A lock-check.yaml
  say "lock: green"
}

cmd_sheets() {  # S5 (T158): two DaVinci uploads — an older categories workbook, then the current one (T144, T130)
  local d1="$OUT/sheets-1" d2="$OUT/sheets-2" stamp rows
  server_up
  # every upload is a new (library, categories) pair, else the server skips it as "already
  # imported": the library gets this run's timestamp (a "newer copy from DaVinci")
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rm -rf "$d1" "$d2" "$OUT/sheets-0"; mkdir -p "$d1" "$d2" "$OUT/sheets-0"
  # the second upload also carries a new DaVinci type whose model sheets-new.yaml first makes by
  # hand in the app library (T111: "1 model clash", the hand-made type untouched)
  for n in 0 1 2; do
    python3 - "$ROOT/fixtures/davinci-library-sample.json" "$OUT/sheets-$n/davinci-library-sample.json" "$stamp rig $n" \
      "$([ $n = 2 ] && echo "MAESTRO-CLASH-${PROJECT//[^0-9]/}")" <<'PY'
import copy, json, sys, uuid
d = json.load(open(sys.argv[1]))
d["timestamp"] = sys.argv[3]
if sys.argv[4]:
    items = lambda t: ((t.get("modelInformation") or {}).get("generatorData") or {}).get("items") or []
    # the Paradigm 7" touchscreen (its model pattern is "P-TS7-E" + a property)
    src = next(t for t in d["types"] if [i.get("value") for i in items(t)][:1] == ["P-TS7-E"])
    t = copy.deepcopy(src)
    t["typeId"] = str(uuid.uuid4())
    t["modelInformation"]["generatorData"]["items"] = [{"type": "string", "value": sys.argv[4]}]
    d["types"].append(t)
json.dump(d, open(sys.argv[2], "w"), indent=1)
PY
  done
  (cd "$ROOT/server" && $COMPOSE cp "$ROOT/scripts/mac/davinci_old_categories.py" api:/tmp/davinci_old_categories.py >/dev/null \
    && $COMPOSE cp "$ROOT/fixtures/DaVinci_categories.xlsx" api:/tmp/DaVinci_categories.xlsx >/dev/null \
    && $COMPOSE exec -T api python /tmp/davinci_old_categories.py /tmp/DaVinci_categories.xlsx /tmp/old.xlsx \
    && $COMPOSE cp api:/tmp/old.xlsx "$d1/DaVinci_categories.xlsx" >/dev/null) || die "could not build the older categories workbook"
  cp "$ROOT/fixtures/DaVinci_categories.xlsx" "$d2/"
  # a run that stopped between its two uploads leaves the server-wide ERn type under Equipment:
  # import the current workbook first (the job's CLI, filed under the seed project), so this run's
  # older upload has something to correct
  if [ "$(server_sql "" "select category from library_type where project_id is null and deleted_at is null
      and model = 'ERn2-W-120 Mk2';")" != "Equipment Panels" ]; then
    say "the app library's ERn2-W-120 Mk2 is not under Equipment Panels (a run stopped half-way): importing the current workbook first"
    (cd "$ROOT/server" && $COMPOSE cp "$OUT/sheets-0/davinci-library-sample.json" api:/tmp/rig-library.json >/dev/null \
      && $COMPOSE exec -T api python -m app.jobs.davinci_library /tmp/rig-library.json --categories /tmp/DaVinci_categories.xlsx \
        --project "$(server_sql "$SEED_PROJECT" "select id from project where name = :'name';")" >/dev/null) \
      || die "could not import the current workbook to put the ERn type back"
  fi
  say "sheets on \"$PROJECT\": the older workbook (ERn → Equipment), an ERn device and P-NSPS-D's Neuron flag by hand; then the current one"
  cmd_files A "$d1/DaVinci_categories.xlsx" "$d1/davinci-library-sample.json" "fixtures/Level_06M_-_Lighting_Composite_vector.pdf"
  RIG_KEEP_FILES=1 USER_NAME=Ann cmd_flows --device A sheets-old.yaml
  cmd_files A "$d2/DaVinci_categories.xlsx" "$d2/davinci-library-sample.json"
  RIG_KEEP_FILES=1 USER_NAME=Ann cmd_flows --device A sheets-new.yaml
  # the two uploads of this run: each corrected the ERn type (and its copies), neither a Neuron flag
  rows="$(server_sql "$PROJECT" "select coalesce(b.stats->>'categories_corrected', '-'), coalesce(b.stats->>'neuron_flags_corrected', '-')
    from import_batch b join project p on p.id = b.project_id
    where p.name = :'name' and b.kind = 'davinci' order by b.created_at;" | tr '\n' ' ')"
  say "server DaVinci batches on \"$PROJECT\" (categories corrected, Neuron flags corrected): $rows"
  # (a project copy of the ERn type nobody edited counts too, on any project of the server)
  echo "$rows" | awk 'NF == 4 && $1 >= 1 && $2 == 0 && $3 >= 1 && $4 == 0 { ok = 1 } END { exit !ok }' \
    || die "expected two batches, each with a category corrected and no Neuron flag; got: $rows"
  say "sheets: green"
}

cmd_library_two() {  # S4 (T158): the second-iPad halves of the library, chips, kits and pin shapes
  local n
  cmd_second
  say "library-two on \"$PROJECT\": A (Ann) sets up a station type, its card, a kit choice, Station → Square and an app type; B (Bob) sees them"
  USER_NAME=Ann cmd_flows --device A library-two.yaml
  USER_NAME=Bob cmd_flows --device B library-two-peer.yaml
  n="$(server_sql "$PROJECT" "select count(*) from cable c join project p on p.id = c.project_id
    where p.name = :'name' and c.deleted_at is null and c.cable = 'N' and c.term_kit = false;")"
  say "N cables on \"$PROJECT\" with Termination kits No on the server: $n"
  [ "${n:-0}" -eq 1 ] || die "expected one N cable with term_kit false"
  say "library-two: green"
}

log_since() {  # A|B, ISO time, regex -> the app's log lines at or after that time that match (T158)
  ( cmd_log "$1" >/dev/null ) || return 1
  cat "$OUT/log-$1"/*.log | awk -v t="$2" '$1 >= t' | grep -E "$3"
}

cmd_ink() {  # F6 (T158): Ann's stroke and the layer switch on A, B sees it and draws, A sees B's
  local t0 t1
  cmd_second
  say "ink on \"$PROJECT\": A (Ann) draws and switches the layer, B (Bob) sees it and draws, A sees both"
  t0="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A ink-setup.yaml
  USER_NAME=Bob cmd_flows --device B ink-peer.yaml
  log_since B "$t0" 'ink_loaded .*"others":1' || die "B's log has no ink_loaded with Ann's one stroke since $t0"
  t1="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A ink-check.yaml
  log_since A "$t1" 'ink_loaded \{"layers":2,"mine":1,"others":1\}' || die "A's log has no ink_loaded with both layers since $t1"
  say "ink: green"
}

cmd_pickup() {  # O5 (T159): B's edits reach A's open screens with no Sync now; a library pull while A scrolls
  local t0 t1 t2 t3 pid
  cmd_second
  say "pickup on \"$PROJECT\": A (Ann) leaves a card open, B (Bob) sets its status; A's library form follows B; A scrolls while B saves three fields"
  USER_NAME=Ann cmd_flows --device A pickup-setup.yaml
  t0="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Bob cmd_flows --device B pickup-peer.yaml
  t1="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A pickup-card.yaml
  sleep 3   # the logger flushes every 1.5 s
  ( cmd_log A >/dev/null && cmd_log B >/dev/null ) || die "no app logs"
  python3 "$ROOT/scripts/mac/applog.py" latency "$OUT/log-A" "$OUT/log-B" "$t0" "$t1" | tee "$OUT/pickup-latency.txt" \
    || die "B's status never reached A's log"
  awk '{ s = $(NF-1); if (s + 0 > 12) exit 1 }' "$OUT/pickup-latency.txt" \
    || die "A pulled B's edit more than 12 s after B pushed it (the poll is 5 s, D130)"
  RIG_ENV="ROUND=1" USER_NAME=Bob cmd_flows --device B pickup-alias.yaml
  USER_NAME=Ann cmd_flows --device A pickup-form.yaml
  # A scrolls (about a minute) while B, already on the type's form, saves three fields at once
  t2="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A pickup-scroll.yaml > "$OUT/pickup-scroll.log" 2>&1 &
  pid=$!
  sleep 10
  RIG_ENV="ROUND=3" USER_NAME=Bob cmd_flows --device B pickup-alias.yaml
  wait "$pid" || { cat "$OUT/pickup-scroll.log"; die "pickup-scroll.yaml failed on A"; }
  t3="$(date -u +%Y-%m-%dT%H:%M:%S)"
  sleep 3
  ( cmd_log A >/dev/null ) || die "no app log on A"
  python3 "$ROOT/scripts/mac/applog.py" burst "$OUT/log-A" "$t2" "$t3" 3 || die "the three-op library pull on A did not check out"
  USER_NAME=Bob cmd_flows --device B pickup-done.yaml
  say "pickup: green"
}

cmd_restart() {  # O6 (T159): the api restarted in the middle of a large push; nothing refused, numbering continues
  local stamp t0 want n q rows states
  server_up
  project_exists "$SCALE_PROJECT" || die "no \"$SCALE_PROJECT\" on the server: rig.sh scale, then rig.sh scale-check (A downloads it)"
  stamp="$(date +%H%M%S)"
  # what the ruling generates: one item per connection end whose cable is not U
  want="$(server_sql "$SCALE_PROJECT" "select count(*) from cable_end ce join cable c on c.id = ce.cable_id
    join project p on p.id = c.project_id
    where p.name = :'name' and ce.deleted_at is null and c.deleted_at is null and c.cable is distinct from 'U';")"
  q="select count(*) from punch_item pi join level l on l.id = pi.level_id join project p on p.id = l.project_id
    where p.name = :'name' and pi.item = 'Restart check $stamp';"
  say "restart on \"$SCALE_PROJECT\": $want punch items generated offline, the api restarted while they push"
  t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_server stop
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  RIG_ENV="STAMP=$stamp" PROJECT="$SCALE_PROJECT" USER_NAME=Ann cmd_flows --device A restart-edit.yaml
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 600); do
    n="$(server_sql "$SCALE_PROJECT" "$q" 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] && break
    sleep 0.2
  done
  [ "${n:-0}" -gt 0 ] || die "the push never reached the server"
  [ "$n" -lt "$want" ] || die "the whole push ($n of $want) was in before the restart: not proven, make it larger"
  (cd "$ROOT/server" && $COMPOSE restart api >/dev/null)
  say "api restarted with $n of $want punch items on the server"
  for _ in $(seq 1 60); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  server_up
  for _ in $(seq 1 300); do
    n="$(server_sql "$SCALE_PROJECT" "$q")"
    [ "$n" -ge "$want" ] && break
    sleep 1
  done
  say "after the restart: $n of $want punch items on the server"
  [ "$n" -eq "$want" ] || die "expected $want punch items \"Restart check $stamp\", the server has $n"
  PROJECT="$SCALE_PROJECT" USER_NAME=Ann cmd_flows --device A restart-check.yaml
  # every op the iPad made since the stop was applied (none refused, none twice)
  states="$(server_sql "$SCALE_PROJECT" "select o.state, count(*) from op o join project p on p.id = o.project_id
    where p.name = :'name' and o.client_ts >= '$t0' group by 1 order by 1;")"
  say "the server's ops since $t0 (state count): $(echo $states)"
  printf '%s\n' "$states" | awk '$1 != "applied" { exit 1 }' || die "an op since the stop is not applied"
  # per numbering group: the new items all numbered, distinct, contiguous, after every older number
  rows="$(server_sql "$SCALE_PROJECT" "with x as (
      select l.numbering_group_id g, pi.number, pi.item = 'Restart check $stamp' as new
      from punch_item pi join level l on l.id = pi.level_id join project p on p.id = l.project_id
      where p.name = :'name' and pi.deleted_at is null)
    select count(*) filter (where new), count(number) filter (where new), min(number) filter (where new),
      max(number) filter (where new), coalesce(max(number) filter (where not new), 0), count(number) - count(distinct number)
    from x group by g order by 3;")"
  say "numbering per group (new, numbered, first, last, older max, duplicates):"
  printf '%s\n' "$rows" | sed 's/^/  /'
  printf '%s\n' "$rows" | awk '$1 > 0 && ($2 != $1 || $4 - $3 + 1 != $1 || $3 <= $5 || $6 != 0) { exit 1 }' \
    || die "numbering did not continue: a gap, a duplicate or a missing number"
  say "restart: green"
}

SCALE_CEILINGS="$ROOT/scripts/mac/scale-ceilings.txt"   # `key ms` per line, set from the first green run (docs/perf/rig.md)

cmd_stranger() {  # T160: the server loses a user's app_user row; the Sync screen says so, Re-sign in sends the edits
  local who t0 t1 gone n
  who="Zed$(date +%H%M%S)"   # a fresh name: its row must hold nothing for the delete to go through
  server_up
  say "stranger on \"$PROJECT\": A (Ann) makes it, signs in as $who, the server loses $who while A edits offline"
  USER_NAME=Ann cmd_flows --device A smoke.yaml   # no Files picker (T168)
  USER_NAME="$who" cmd_flows --device A stranger-signin.yaml
  cmd_server stop
  trap 'cmd_server start >/dev/null 2>&1 || true' EXIT
  gone="$(server_sql "$who" "delete from app_user where name = :'name' returning id;" | head -n1)" \
    || die "$who's app_user row could not be deleted: the sign-in already wrote something under it"
  [ -n "$gone" ] || die "no app_user named $who on the server: the sign-in did not reach it"
  say "deleted $who ($gone) from app_user, as a restore from an old backup would"
  t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  USER_NAME="$who" cmd_flows --device A stranger-edit.yaml
  t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cmd_server start
  trap - EXIT
  for _ in $(seq 1 30); do curl -fsS "$SERVER_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  server_up
  USER_NAME="$who" cmd_flows --device A stranger-check.yaml
  n="$(server_sql "$PROJECT" "select count(*) from op o join project p on p.id = o.project_id join app_user u on u.id = o.user_id
    where p.name = :'name' and o.entity_kind = 'level' and o.field = 'surveyed' and o.state = 'applied'
      and o.client_ts >= '$t0' and o.client_ts <= '$t1' and u.name = '$who' and u.id <> '$gone';")"
  [ "$n" -ge 1 ] || die "the offline surveyed-date edit is not on the server under $who's new id"
  ( cmd_log A 'reattributed' ) || die "no reattributed line in A's log"
  say "stranger: green ($n surveyed-date edit made under the lost id applied as $who's new id)"
}

cmd_scale_check() {  # W5 (T159): the scale project's timings on a fresh store, held to the ceilings
  local t0 t1 pid res bad="" k c v
  server_up
  project_exists "$SCALE_PROJECT" || die "no \"$SCALE_PROJECT\" on the server: rig.sh scale first"
  pid="$(server_sql "$SCALE_PROJECT" "select id from project where name = :'name';")"
  say "scale-check: a fresh store on A downloads \"$SCALE_PROJECT\" (and every rig project), its 06M plan, the 500-pin demo"
  t0="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A scale.yaml
  t1="$(date -u +%Y-%m-%dT%H:%M:%S)"
  USER_NAME=Ann cmd_flows --device A scale-demo.yaml
  sleep 3   # the logger flushes every 1.5 s
  ( cmd_log A >/dev/null ) || die "no app log on A"
  res="$(python3 "$ROOT/scripts/mac/applog.py" scale "$OUT/log-A" "$t0" "$t1" "$pid")"
  printf '%s\n' "$res" > "$OUT/scale-$(date +%m%d-%H%M%S).txt"
  say "scale numbers (ms unless named):"
  printf '%s\n' "$res" | sed 's/^/  /'
  [ -f "$SCALE_CEILINGS" ] || { say "no ceilings yet ($SCALE_CEILINGS): set them from these numbers"; return; }
  while read -r k c; do
    case "$k" in ''|\#*) continue ;; esac
    v="$(printf '%s\n' "$res" | awk -v k="$k" '$1 == k { print $2 }')"
    if [ -z "$v" ]; then bad="$bad $k(not logged)"
    elif [ "$v" -gt "$c" ]; then bad="$bad $k=$v>$c"
    fi
  done < "$SCALE_CEILINGS"
  [ -z "$bad" ] || die "over the ceiling (scripts/mac/scale-ceilings.txt):$bad"
  say "scale-check: green (every number under its ceiling)"
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
  metro) shift; cmd_metro "$@" ;;
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
  place-two) cmd_place_two ;;
  offline) shift; cmd_offline "$@" ;;
  conflicts) cmd_conflicts ;;
  same-user) cmd_same_user ;;
  resume) cmd_resume ;;
  projects) cmd_projects ;;
  review) cmd_review ;;
  export) cmd_export ;;
  photos) cmd_photos ;;
  ink) cmd_ink ;;
  lock) cmd_lock ;;
  library-two) cmd_library_two ;;
  sheets) cmd_sheets ;;
  drafts) shift; cmd_drafts "$@" ;;
  pickup) cmd_pickup ;;
  scale-check) cmd_scale_check ;;
  restart) cmd_restart ;;
  stranger) cmd_stranger ;;
  -h|--help|help|"") usage ;;
  *) usage; die "unknown command: $1" ;;
esac
