# StarLoot Companion

A small, dependency-free Node.js script that reads Star Citizen's `Game.log`
and turns it into a **sync file** (`starloot-sync.json`) — a snapshot of the
items you've picked up, stored, or equipped since you started tracking. You
upload that file into StarLoot's personal dashboard (Import) to populate a
stockpile, without ever touching a third-party API or sending your log
anywhere.

Everything runs locally. The script never makes a network call.

This is the public home of the companion. It is also distributed inside
[StarLoot](https://starloot.app) itself (Import modal, members-only) — both
builds come from this same source.

## Download

- **Windows, easiest:** grab `starloot-companion.exe` from the
  [latest release](../../releases/latest) and double-click it. Verify the
  download against `checksums.txt` from the same release if you like.
- **Any OS, most transparent:** download `starloot-companion.mjs` (also on
  the release, or just this repo's copy) and run it with Node.js 18+:
  `node starloot-companion.mjs`

Every release's `.exe` is built by the
[release workflow](.github/workflows/release.yml) in this repository's CI —
never on a developer machine — from the tagged source you can read here.

## What it does

1. Reads `Game.log` (and, optionally, every backed-up session in SC's
   `logbackups` folder) line by line.
2. Recognises a handful of inventory-related log lines: items stored into
   containers, items equipped/taken out, items dropped/spawned, your
   worn/carried loadout, and the location you were at when it happened.
3. Reduces all of that into a **ledger**: for every (item class, container)
   pair, a best-effort current quantity, tagged with the last known location
   code.
4. Writes it all out as `starloot-sync.json`, which StarLoot's Import feature
   reads to propose stockpile items for you to accept.

## SAFETY

**Guarantees:**

- Runs as a normal user — no admin/elevated privileges requested or required.
- Reads `Game.log` and `global.ini` **read-only**. It never modifies, moves,
  or deletes anything belonging to Star Citizen.
- Writes **exactly one** output file: `starloot-sync.json` (or whatever `--out`
  path you give it), right next to wherever you ran it from.
- **No network connections**, ever — this is enforced by the code only using
  `node:fs`, `node:path`, `node:crypto`, `node:url`, and `node:readline`, no
  networking module is imported at all.
- **No background processes, no installation, no persistence.** It runs,
  writes its one file, and exits. Nothing is left running or scheduled.
- Refuses to overwrite a file it didn't create itself (a "clobber guard"
  checks any existing output path looks like a prior `starloot-sync.json`
  before touching it — otherwise it picks a different filename instead).
- Any error is caught and shown as a plain one-line message — never a raw
  crash or stack trace — and no partial/corrupt output file is ever left
  behind (writes go to a temp file, then an atomic rename over the real
  target).

**The `.exe` distribution:** StarLoot serves a double-clickable
`starloot-companion.exe` for Windows users who don't want to install Node.js.
It's built automatically in CI from this exact `starloot-companion.mjs`
source file — nothing hand-assembled, no separate codebase. To keep that
honest and checkable:

- The `.exe` is **unsigned** (deliberately — see below), so Windows SmartScreen
  will show an "unknown publisher" warning. Choose **More info → Run anyway**.
  This is normal for small, unsigned tools and does not mean anything is wrong.
- A `checksums.txt` (sha256) is published alongside the `.exe` so you can
  verify your download matches exactly what CI built.
- The plain `starloot-companion.mjs` script is downloadable next to the
  `.exe` — read it yourself, then run it with `node starloot-companion.mjs`
  if you'd rather not run an unsigned binary at all.
- **Antivirus honesty note:** unsigned executables built this way can
  occasionally trigger antivirus false positives (heuristic detection on
  "unknown, unsigned, packages Node.js" patterns, not any actual malicious
  behavior). If your AV flags it, the plain script version is the same code
  with none of that risk surface.

## What it honestly does NOT do (limitations)

- **Deltas only.** The script only knows about items you've moved, stored, or
  equipped *since you started tracking* (i.e., since your earliest available
  `Game.log`/backup covers). It has no idea what was already sitting in a
  container before that — there's no "give me my whole inventory" log line to
  read. If you want a complete picture, keep your `logbackups` folder around
  and point `--backups` at it.
- **Quantities are best-effort**, not authoritative. Star Citizen's inventory
  log lines describe *individual entity moves*, not stack counts, so the
  script infers quantity by counting distinct entities. Stackable consumables
  (med pens, ammo, etc.) usually come through fine because each pickup is its
  own log line, but if the game's own logging skips a line (dropped log
  messages happen), the script's count can drift from reality.
- **No ore / cargo / SCU-commodity tracking.** Mined ore, refined commodities,
  and anything living in a ship's cargo grid are NOT captured — those don't
  go through the personal-inventory log lines this script understands. This
  is a deliberate scope cut, not an oversight: if you're looking for cargo
  hold tracking, this tool won't help (yet).
- **`Move` (item moved directly between two named inventories, as opposed to
  `Store`) is implemented from the same log grammar as `Store`, but it was
  never observed in the real session used to build/verify this script.**
  Treat it as best-effort/untested until someone captures a real example.
- **Bulk multi-item moves** (a single request moving several item classes at
  once) were not observed either. If SC's log ever emits one, today's parser
  will simply not recognise that specific line and will skip it — it won't
  corrupt your ledger, it'll just miss that move.
- **Location codes are internal game codes** (e.g. `RR_ARC_LEO`), not always
  human-friendly names. StarLoot's import step will do its best to prettify
  them, but you may see the raw code if we don't recognise it.
- **Location tagging is a heuristic**, not a hard guarantee. The script uses
  "most-recent-location-seen" to tag container activity, and if no location
  was seen yet at all when an item first shows up, it backfills using the
  *last* location seen anywhere in the log — a "you were probably still
  there" assumption that holds for the common single-location session but
  can be wrong if you moved around a lot between location prompts.
- **Worn/carried loadout items are tracked internally** (so equip/store
  round-trips net out correctly) but they're not really "stockpile" material
  — StarLoot's import only offers items sitting in `Container`/`Location`
  inventory refs, not things you're currently wearing or holding.

## Requirements

- Node.js **18 or later**. No `npm install` needed — this is a single file,
  zero dependencies.

## Usage

### Easiest: double-click `starloot-companion.exe`, no flags at all

Download `starloot-companion.exe` from the [latest release](../../releases/latest)
(or from StarLoot's Import modal — same build) and double-click
it (or run `node starloot-companion.mjs` with no arguments). With no flags, it
tries to auto-locate your `Game.log` at the usual install paths, auto-includes
its sibling `logbackups` folder and `global.ini` if present, writes
`starloot-sync.json` next to itself, prints a short summary, and waits for you
to press Enter before closing. If it can't find your `Game.log` automatically,
it asks you to paste the path.

### Flag-driven (scripting / non-default install paths)

```bash
node starloot-companion.mjs --log "C:\Users\you\AppData\Roaming\rsi\StarCitizen\LIVE\Game.log" --out starloot-sync.json
```

Include prior sessions too (recommended — the more history, the more
complete your picture):

```bash
node starloot-companion.mjs ^
  --log "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Game.log" ^
  --backups "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\logbackups" ^
  --out starloot-sync.json
```

Only include events after a certain date:

```bash
node starloot-companion.mjs --log Game.log --since 2026-08-01T00:00:00Z
```

Get real item display names instead of the prettified fallback (see below):

```bash
node starloot-companion.mjs --log Game.log --ini "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Data\Localization\english\global.ini"
```

Run the bundled self-test (parses `fixtures/sample-lines.log` and checks a
few expected results — useful to confirm your Node install works):

```bash
node starloot-companion.mjs --self-test
```

### All options

| Flag | Description |
| --- | --- |
| `--log <path>` | Path to your current `Game.log`. Required unless `--backups` is given, or `--self-test`. |
| `--backups <dir>` | Path to SC's `logbackups` folder — every `Game*.log` inside is parsed too, oldest session first. |
| `--out <path>` | Output file path. Defaults to `starloot-sync.json` in the current directory. |
| `--since <ISO date>` | Ignore any log line before this timestamp. |
| `--ini <path>` | Path to `Data/Localization/english/global.ini` for real item display names. |
| `--self-test` | Run the built-in self-test against the bundled fixture and exit. |
| `--help` | Show usage. |

## Finding your `Game.log`

By default, Star Citizen's LIVE build writes its log next to the game
executable, typically:

```
<StarCitizen install dir>\LIVE\Game.log
```

For example, if you installed via the RSI launcher to the default location:

```
C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\Game.log
```

Prior sessions get copied into a `logbackups` subfolder next to it:

```
C:\Program Files\Roberts Space Industries\StarCitizen\LIVE\logbackups\
```

In no-flags interactive mode the script checks a list of common install
paths automatically and prompts you for the path if none match. Flag-driven
runs never guess — pass `--log` (and optionally `--backups`) pointing at
wherever yours actually is.

## Finding `global.ini` (optional, for nicer item names)

If you want real display names ("Greycat Multi-Tool") instead of the
fallback prettifier's best guess ("Grin Multitool 01 Tractorbeam"), point
`--ini` at:

```
<StarCitizen install dir>\LIVE\Data\Localization\english\global.ini
```

This file ships with the game and is safe to read — the script never
modifies it. If you don't pass `--ini`, or the file can't be found, the
script falls back to prettifying the raw class name (splitting on
underscores, title-casing, and dropping trailing numeric/size tokens).

## Output format (`starloot-sync/1`)

```json
{
  "format": "starloot-sync/1",
  "generatedAt": "2026-08-06T09:00:00.000Z",
  "player": "Morrschyvens",
  "gameVersion": "4.9.188.23497",
  "sessions": [{ "start": "2026-08-04T19:58:31.643Z", "file": "Game.log" }],
  "trackingSince": "2026-08-04T19:58:31.643Z",
  "items": [
    {
      "class": "grin_multitool_01_tractorbeam",
      "displayName": "Grin Multitool 01 Tractorbeam",
      "quantity": 1,
      "containerRef": "718156344314:Container:0",
      "locationCode": "RR_ARC_LEO",
      "lastSeen": "2026-08-04T20:14:45.470Z",
      "eventIds": ["28528"]
    }
  ],
  "eventHashes": ["<sha256 of every raw log line that contributed>"]
}
```

`eventHashes` lets StarLoot detect re-imports of the same sync file — upload
it twice and everything shows up as "already imported" instead of doubling
your stockpile.

## Testing / fixtures

- `fixtures/sample-lines.log` — ~14 real, hand-picked lines from an actual
  SC 4.9.188 session (the user's own log, safe to share/commit), covering
  every event type this script understands.
- `fixtures/sample-sync.json` — the exact output of running this script
  against the *full* real session log that `sample-lines.log` was excerpted
  from (not committed — see below). Regenerate it with:

  ```bash
  node starloot-companion.mjs --log /path/to/that/Game.log --out fixtures/sample-sync.json
  ```

- `node starloot-companion.mjs --self-test` parses `fixtures/sample-lines.log`
  and asserts a handful of expected results (player name, game version, the
  tractor-beam multi-tool landing in the right container with the right
  location, etc). Run it any time you touch the parser.

We deliberately do **not** commit the full `Game.log` this was developed
against — it's a large (and mildly identifying) file. The fixtures above are
enough to exercise and regression-test every code path.
