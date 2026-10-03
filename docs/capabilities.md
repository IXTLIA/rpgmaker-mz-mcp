# Project analysis, live testing, and map generation

These additions adapt useful MV MCP capabilities to MZ's existing registry,
validation, tile helpers, and preview system. They add twelve tools covering six
areas. They do not require an external AI service or upload project content.

## 1. Project diagnostics

`analyze_project` is read-only. Its `view` selects the report:

| View | Arguments beyond `view` | Result |
| --- | --- | --- |
| `overview` (default) | None | Counts, reference warnings, missing and statically unreachable maps |
| `graph` | Optional `removeMapId` | Direct transfer graph, called common events, reachability, downstream removal impact |
| `explain` | `namespace: "switch" / "variable"`, `id` | Static readers, writers, and cautious diagnostic clues |
| `usage` | Same; also `namespace: "common_event"` | Reference locations |
| `outline` | Target IDs below | Readable event tree including MZ speaker names and plugin commands |
| `balance` | Optional `category`, `thresholdSd` | Peer comparisons described below |
| `search` | `query`, optional `limit` | Ranked project text |
| `duplicates` | Optional `minLength`, `limit` | Repeated command windows for review |

Outline targets: `target: "map_event"` (default) with `mapId` and `eventId`;
`target: "common_event"` with `commonEventId`; or `target: "troop_page"` with
`troopId`. `pageIndex` is zero-based and defaults to `0`.

Example calls:

```json
{ "view": "explain", "namespace": "switch", "id": 12 }
```

```json
{ "view": "outline", "mapId": 3, "eventId": 7, "pageIndex": 0 }
```

These are static reports. Dynamic transfers, script/plugin references, event page
conditions, and runtime state prevent a graph from proving actual playability.
An absent static writer is a clue, not proof that a switch is never changed.
Outlines are best-effort summaries; `validate_event` remains the structural audit.

## 2. Live MZ playtest bridge

Use a disposable test project first. The bridge is a local NW.js test-mode plugin;
it is inactive in ordinary deployed play. It accepts a fixed command vocabulary,
not arbitrary JavaScript. The server binds only to loopback and authenticates one
game connection using a private project handshake. Status responses omit its token.

| Tool | Purpose |
| --- | --- |
| `install_runtime_bridge` | Add/enable `McpMzBridge.js`, preserving other plugin entries |
| `start_runtime_bridge` | Open the bridge; optional `port` (default `32124`, `0` chooses an available port) |
| `runtime_status` | Read connection state and project identity |
| `launch_playtest` | Launch NW.js and return its PID; does not imply a successful game boot |
| `runtime_telemetry` | Read bounded exception/log/scene/player/event-command telemetry |
| `runtime_command` | Inspect state, send controlled input, transfer, or reload supported data |
| `runtime_screenshot` | Save a game-scene PNG under `.mcp-cache/screenshots` |
| `stop_runtime_bridge` | Disconnect and remove this server's handshake; leaves the game running |

Suggested sequence:

1. Select the project with `set_project`.
2. Preview `install_runtime_bridge` with `dryRun: true`, then apply it.
3. Call `start_runtime_bridge`, then `launch_playtest`.
4. Wait for `runtime_status.connected`, then inspect state or telemetry.
5. Stop the bridge and close the launched playtest when done.

`launch_playtest` accepts `runtimeExecutable` or `install`; alternatively set
`RPGMAKER_MZ_INSTALL`. On Windows it also recognizes the standard Steam installation.
Use a standalone NW.js executable, not one bound to another game's adjacent
`package.json`. Game input requires the game to be active/focused as MZ normally does.

Commands use `action`: `ping`, `get_state`, `capture_screenshot`, `press_button`,
`interact`, `teleport_player`, `reload_map`, or `reload_database`.

```json
{ "action": "press_button", "button": "ok", "durationMs": 100 }
```

```json
{ "action": "teleport_player", "mapId": 2, "x": 4, "y": 6, "direction": 2 }
```

Transfers/map reloads require an idle map and acknowledge after map loading.
Database reload accepts Actors, Classes, Skills, Items, Weapons, Armors, Enemies,
Troops, States, or CommonEvents JSON filenames. It refreshes the database array;
it does not rebuild existing actors, enemies, or interpreter instances. Restart
the playtest for System/Tilesets, engine, or plugin changes.

Runtime side-effect tools explicitly support `dryRun` without opening sockets,
launching a process, sending input, capturing images, or writing files. Plugin
installation participates in the normal file diff preview. Changed existing
plugin source requires `replaceExisting: true`; existing text is backed up.
Plugin/manifest writes stage both files first and roll back on ordinary I/O
failure; they are not a crash-atomic multi-file transaction.

Changing the selected project stops the current bridge before switching targets.
A second MCP session's handshake is not overwritten. If a process crashes,
inspect and remove its stale `.mcp-mz-bridge.json` only after confirming that
session has ended. Tracing observes command execution; it is not a breakpoint
debugger. Screenshots capture the game scene, not the desktop. Video recording is
not part of this implementation.

## 3. Map layout analysis

`analyze_map_layout` takes `mapId`, optional `start: {x,y}`, and optional
`maxComponents`. It measures connected regions, reachable cells, isolated cells,
tile repetition, and event positions relative to reachable space. It honors
looping maps and both sides of directional tile passage. Without `start`, it uses
the largest connected component, not an inferred player spawn.

Active event pages, character collision, vehicles, plugins, and dynamic map
changes remain unknown. A repetitive floor or disconnected region may be
intentional. Image dimensions and visual appearance are not evaluated.

## 4. Balance analysis

Use `analyze_project` with `view: "balance"`. `category` accepts `all` (default),
`skills`, `weapons`, `armors`, or `enemies`; `thresholdSd` defaults to `2`.
Reports compare each entry with its peers, excluding it from its own comparison.
Unparseable damage formulas are reported separately and never executed.

These ratios and fixed reference stats are review aids. Progression tiers,
targeting, traits, status effects, TP, and plugins can justify an apparent outlier.
Small samples are explicitly marked insufficient. No data is rebalanced.

## 5. Project text and duplicate logic

`view: "search"` ranks names, dialogue, descriptions, and notes using local
token/phrase matching. It is lexical search, not an embedding service.

`view: "duplicates"` locates repeated command windows across map events, common
events, and troop pages. Results propose review; they never extract or rewrite
commands. Event context, self switches, branch structure, and character targets
must be checked before converting a repeated block into a common event.

## 6. Map generation

`generate_dungeon_map` creates a new seeded rooms-and-corridors layout. Supply
`name`, `tilesetId`, `seed`, and a `tileProfile` with real project `floorTileId` and
`wallTileId` values (optional `corridorTileId`). Optional controls are `width`,
`height`, `roomCount`, `minRoomSize`, `maxRoomSize`, and `parentId`.

The selected floor/corridor tiles must allow all four directions; walls must block
all four. Assigned sheets must exist. Autotiles are reshaped with MZ's solver,
and generated walkable space is checked for static connectivity. The same input
seed/profile/dimensions produces the same layout. Room count can be reduced when
the requested rooms cannot fit; the response reports that explicitly.

Returned entrance/key/door/boss/exit markers are design metadata. They do not
create locks, rewards, encounters, battles, or quest events, and do not prove a
future lock-and-key puzzle is solvable.

`generate_map_from_template` takes `sourceMapId`, `name`, optional `parentId`,
optional `tilesetId`, and optional `tileRemap: [{from,to}]`. It creates a new layout
from an existing project map, copying tile/shadow/region layers and scroll type.
Events, encounters, plugin notes, audio, and parallax are omitted. Tile remapping
uses exact raw IDs and recalculates affected autotile layers. Select compatible
art explicitly; there is no automatic artwork or semantic inference.

Both generators support `dryRun: true`. New map IDs are allocated without
overwriting existing files. Map data and map-tree updates are staged together,
with cleanup on ordinary I/O errors. They use only project-owned sheets and
layouts; no engine assets or reference maps are bundled.

## Verification

```sh
npm run typecheck
npm run lint
npm run format:check
npm run sync:tools:check
npm run sync:version:check
npm test
npm run build
npm run test:protocol
```

The stdio harness uses generated temporary fixtures and exercises discovery,
all analysis views, previews, generation commits, concurrent allocation, plugin
installation, and bridge target/connection cleanup. Engine behavior and rendering
require the separate local MZ playtest verification with a licensed installation.
