# Maestro flows (T149, D248)

What Claude runs on the Mac test rig against the iOS Simulator: `bash scripts/mac/rig.sh flows`
(`docs/ops.md` §6). `smoke.yaml` is the entry; files starting with `_` are sub-flows it includes.
Every flow talks to the local e2e server (`rig.sh server`, 127.0.0.1:8010, token `e2e`, team Ann / Bob),
never to the Droplet.

| Flow | Walks |
|---|---|
| `_launch.yaml` | fresh launch; a dev client loads from Metro by deep link (`METRO_URL`), a `--release` build does not |
| `_connect.yaml` | Connect to server (URL, token) → pick the name `USER` |
| `_new-project.yaml` | Projects → + New project (name with the time, level 06M) → home → open the level → back |
| `_sync.yaml` | Sync → Sync now → `Synced <time>` → back |

Selectors: `id:` is the control's `testID` (`<screen>.<element>`, CLAUDE.md §5); plain text is a
regex on what is visible. A flow for a new screen gets its `testID`s in the same task.
Variables come from `rig.sh` (`-e SERVER_URL=… TOKEN=… METRO_URL=… USER=…`; its `RIG_*` defaults).
Top-level flows carry no `env:` block: a flow's own `env:` beats `-e` (T151), so run them through
`rig.sh`, or pass all four `-e` values to `maestro test` yourself. Failed steps leave screenshots under `~/.maestro/tests/` and the
`--debug-output` folder the script prints.
