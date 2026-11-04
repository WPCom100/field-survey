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

env: RIG_SERVER_URL RIG_TOKEN RIG_METRO_URL RIG_USER RIG_PROJECT RIG_SIM_A RIG_SIM_B
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
      $COMPOSE up -d --build postgres s3 api worker   # the worker runs the upload jobs (T151)
      # a fresh volume runs initdb first: migrating before Postgres accepts connections fails (T151)
      for _ in $(seq 1 60); do $COMPOSE exec -T postgres pg_isready -q && break; sleep 1; done
      $COMPOSE exec -T postgres pg_isready -q || die "Postgres did not become ready within 60 s: $COMPOSE logs postgres"
      $COMPOSE exec -T api alembic upgrade head
      $COMPOSE exec -T api python -m app.storage ensure-bucket
      for _ in $(seq 1 30); do
        if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then say "health: ok ($SERVER_URL)"; return; fi
        sleep 1
      done
      die "the API did not answer on $SERVER_URL/health within 30 s: $COMPOSE logs api"
      ;;
    stop) $COMPOSE stop api; say "api stopped: the app is offline now" ;;
    start) $COMPOSE start api; say "api started" ;;
    reset) $COMPOSE down -v; say "server data wiped; run 'rig.sh server' again" ;;
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
    -e PROJECT="$PROJECT" \
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
  -h|--help|help|"") usage ;;
  *) usage; die "unknown command: $1" ;;
esac
