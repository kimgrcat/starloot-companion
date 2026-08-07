#!/usr/bin/env node
/**
 * StarLoot Companion — Game.log → starloot-sync.json
 *
 * Parses Star Citizen's Game.log (and optionally logbackups\Game*.log files)
 * into a "sync file" that StarLoot's Import feature can read to populate a
 * personal stockpile with items you've picked up / stored / equipped.
 *
 * ZERO npm dependencies — Node >= 18 stdlib only. Cross-platform, but
 * targets Windows usage (Star Citizen only runs on Windows).
 *
 * Usage:
 *   node starloot-companion.mjs --log "C:\...\Game.log" [--backups "C:\...\logbackups"] [--out starloot-sync.json] [--since 2026-08-01T00:00:00Z] [--ini "C:\...\global.ini"]
 *   node starloot-companion.mjs --self-test
 *
 * See README.md for full docs and honest limitations.
 *
 * -------------------------------------------------------------------------
 * LOG FORMAT NOTES (verified against a real SC 4.9.188 Game.log)
 * -------------------------------------------------------------------------
 * Line envelope:
 *   <ISO-8601 UTC> [Notice] <Category> message [Team_...][Inventory]
 *
 * Inventory refs look like `ownerId:Kind:instanceId` where
 * Kind ∈ Location | Container | ClientOnly, and `INVALID` means "none".
 *
 * Events we understand:
 *   1. Store   — item placed into a container.
 *        Queued Request[N] Type[Store] ... Target Inventory[REF]. ...
 *          Item[<class>_<id>] action[None]. ...
 *      Confirmed by a later:
 *        <Player Inventory Request Complete> Request[N] ... Result[Succeed]
 *      We only count a Store as "landed" once its request id has a
 *      matching Succeed completion line.
 *
 *   2. Move    — item moved from one inventory to another (both refs valid).
 *      NOT observed in our real sample session (only Store + QueryInventory
 *      request types appear). Implemented from the same field grammar as
 *      Store/Queued lines below, but UNTESTED ON REAL DATA — flagged here
 *      and in the README.
 *
 *   3. Equip / take out of a container:
 *        <EquipItem> Request[N] equip from Inventory[REF] Class[<class>] ...
 *      The item class LEAVES that inventory (net effect: -1 there).
 *      Immediately followed (once request N succeeds) by an
 *      <UnstowPendingEntities> spawn line carrying the new instance id, and
 *      an <AttachmentReceived> line as it lands on a body port.
 *
 *   4. Drop / spawn into world (or into hands):
 *        <UnstowPendingEntities> Unstow Request[N] ... finalized spawn of
 *          '<class>_<id>' [<id>], 0 remaining
 *
 *   5. Loadout enumeration on spawn (persistent gear already worn/carried):
 *        <AttachmentReceived> Player[<name>] Attachment[<class>_<id>, <class>, <id>]
 *          Status[persistent] Port[<port>]
 *      Only Status[persistent] rows are counted — Status[local] rows are
 *      transient client-side drag states that get superseded.
 *
 *   6. Location binding:
 *        <RequestLocationInventory> Player[<name>] requested inventory for
 *          Location[<CODE>]
 *      We use "most-recent-location-wins": the last Location[] code seen
 *      before a container's activity is used to tag that container.
 *
 *   7. Session header — first lines of the file:
 *        Log started on ...
 *        FileVersion: <game version>
 *        Executable: <path>
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// NOTE: build-exe.mjs mechanically rewrites this exact line (regex match on
// `dirname(fileURLToPath(import.meta.url))`) to the CJS equivalent (`__dirname`,
// which Node provides natively in CommonJS modules) when producing the .cjs used
// to build the SEA blob. Keep this line's shape stable — see build-exe.mjs header.
const __dirname = dirname(fileURLToPath(import.meta.url));

const FORMAT = 'starloot-sync/1';
const COMPANION_VERSION = '0.1.1';

// ---------------------------------------------------------------------------
// Crash diagnostics
// ---------------------------------------------------------------------------

/** Path the crash log is written to — always alongside the current working directory. */
const ERROR_LOG_PATH = join(process.cwd(), 'starloot-companion-error.log');

/** true once --verbose is parsed off argv; read by verboseLog() below. */
let verboseEnabled = false;

/** Print a line only when --verbose is set. */
function verboseLog(msg) {
	if (verboseEnabled) console.log(msg);
}

/**
 * Append a diagnostic block to starloot-companion-error.log next to the CWD.
 * Never throws — a failure while trying to log a crash must not mask the
 * original crash or crash the crash handler itself.
 */
function appendErrorLog(err, context) {
	try {
		const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err);
		const lines = [
			'-----------------------------------------------------------------',
			`Time:                ${new Date().toISOString()}`,
			`Companion version:   ${COMPANION_VERSION}`,
			`Node version:        ${process.version}`,
			`Platform:            ${process.platform} (${process.arch})`,
			`Context:             ${context}`,
			`Verbose mode:        ${verboseEnabled}`,
			'',
			stack,
			'-----------------------------------------------------------------',
			''
		];
		appendFileSync(ERROR_LOG_PATH, lines.join('\n') + '\n');
	} catch {
		// Best-effort only — nothing more we can do if even this fails.
	}
}

/**
 * Install global crash handlers. On an uncaught exception or unhandled
 * rejection: log the diagnostic block, print a short friendly pointer to the
 * log file, then either wait for Enter (interactive mode, so a double-clicked
 * console window doesn't vanish) or exit(1) immediately (flag-driven mode —
 * scripts/CI should never block on stdin).
 */
function installCrashHandlers(isInteractive) {
	async function handle(err, kind) {
		appendErrorLog(err, kind);
		console.error(`\nSomething went wrong and StarLoot Companion crashed (${kind}).`);
		console.error(`Details were saved to: ${ERROR_LOG_PATH}`);
		console.error('Please include that file if you report this.');
		if (isInteractive) {
			await waitForEnterToExit();
			process.exit(1);
		} else {
			process.exit(1);
		}
	}

	process.on('uncaughtException', (err) => {
		handle(err, 'uncaughtException');
	});
	process.on('unhandledRejection', (reason) => {
		handle(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
	});
}

// ---------------------------------------------------------------------------
// Well-known Game.log install locations (double-click / no-args mode only)
// ---------------------------------------------------------------------------

/** Candidate Game.log paths to probe, in priority order, Windows-only. */
const WELL_KNOWN_LOG_PATHS = [
	'C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'D:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'E:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'F:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'G:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'H:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'C:\\Program Files (x86)\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'D:\\Program Files (x86)\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log',
	'C:\\Games\\StarCitizen\\LIVE\\Game.log',
	'D:\\Games\\StarCitizen\\LIVE\\Game.log',
	'D:\\StarCitizen\\LIVE\\Game.log',
	'E:\\StarCitizen\\LIVE\\Game.log'
];

/** Find the first well-known Game.log path that exists on disk, or null. Windows-only. */
function autoLocateGameLog() {
	if (process.platform !== 'win32') return null;
	for (const p of WELL_KNOWN_LOG_PATHS) {
		if (existsSync(p)) return p;
	}
	// %LOCALAPPDATA%-relative variant some third-party launchers use.
	const localAppData = process.env.LOCALAPPDATA;
	if (localAppData) {
		const candidate = join(localAppData, 'rsi', 'StarCitizen', 'LIVE', 'Game.log');
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Given a discovered Game.log path, return the sibling `logbackups` dir if present. */
function autoLocateBackups(logPath) {
	const dir = dirname(logPath);
	const candidate = join(dir, 'logbackups');
	return existsSync(candidate) ? candidate : null;
}

/** Given a discovered Game.log path, return the sibling global.ini path if present. */
function autoLocateIni(logPath) {
	const dir = dirname(logPath);
	const candidate = join(dir, 'Data', 'Localization', 'english', 'global.ini');
	return existsSync(candidate) ? candidate : null;
}

/** Prompt the user on stdin for a path; returns the trimmed answer. */
function promptStdin(question) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

/** Wait for Enter so a double-clicked console window doesn't vanish before you can read it. */
function waitForEnterToExit() {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question('\nPress Enter to exit...', () => {
			rl.close();
			resolve();
		});
	});
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = { out: 'starloot-sync.json' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--log') args.log = argv[++i];
		else if (a === '--backups') args.backups = argv[++i];
		else if (a === '--out') args.out = argv[++i];
		else if (a === '--since') args.since = argv[++i];
		else if (a === '--ini') args.ini = argv[++i];
		else if (a === '--self-test') args.selfTest = true;
		else if (a === '--verbose') args.verbose = true;
		else if (a === '--help' || a === '-h') args.help = true;
	}
	return args;
}

function printHelp() {
	console.log(`StarLoot Companion — Game.log -> starloot-sync.json

Usage:
  node starloot-companion.mjs --log <path> [options]
  node starloot-companion.mjs --self-test

Options:
  --log <path>       Path to Star Citizen's Game.log (required unless --self-test)
  --backups <dir>    Directory of prior sessions (SC's "logbackups" folder) —
                      every Game*.log inside is also parsed, oldest-session-first
  --out <path>       Output sync file (default: starloot-sync.json)
  --since <ISO date> Ignore log lines before this timestamp
  --ini <path>       Path to Data/Localization/english/global.ini for display names
  --self-test        Parse the bundled fixture lines and assert expected counts
  --verbose          Print per-file progress (lines/events parsed) as it runs;
                      the same detail is included in starloot-companion-error.log
                      if a crash happens
  --help             Show this help

See README.md for how to find your Game.log and global.ini.
`);
}

// ---------------------------------------------------------------------------
// Log line parsing
// ---------------------------------------------------------------------------

const LINE_RE = /^<([^>]+)>\s*(.*)$/;

/** Strip a trailing `_<digits>` instance-id suffix off an item token to get its class. */
function classFromItemToken(token) {
	return token.replace(/_\d+$/, '');
}

/**
 * Parse a single raw log line into a structured event, or null if irrelevant.
 * `lineNo` / `sourceFile` are carried through for diagnostics only.
 */
function parseLine(raw) {
	const m = LINE_RE.exec(raw);
	if (!m) return null;
	const timestamp = m[1];
	// Strip an optional leading severity tag (`[Notice]`, `[Warning]`, etc.) so
	// `rest` starts directly at the category tag (`<InventoryManagementRequest>` etc.)
	const rest = m[2].replace(/^\[[A-Za-z]+\]\s*/, '');

	// Only ISO-8601 timestamps are useful to us (skip startup banner lines with plain dates).
	if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return null;

	// --- Session header fields -------------------------------------------------
	if (rest.startsWith('FileVersion:')) {
		return { type: 'gameVersion', timestamp, version: rest.replace('FileVersion:', '').trim(), raw };
	}
	if (rest.startsWith('Log started on')) {
		return { type: 'sessionStart', timestamp, raw };
	}

	// --- Queued Store/Move requests ---------------------------------------------
	// e.g. Queued Request[28528] Type[Store] for 'Morrschyvens' [204698936815]
	//        Source Inventory[INVALID] Target Inventory[718156344314:Container:0].
	//        Source[NULL] amount[0] rank[]. Target[NULL] amount[0] rank[].
	//        Item[grin_multitool_01_tractorbeam_350026627816] action[None]. ...
	let mm = /^<InventoryManagementRequest> Queued Request\[(\d+)\] Type\[(Store|Move)\] for '([^']+)'.*?Source Inventory\[([^\]]+)\] Target Inventory\[([^\]]+)\]\..*?Item\[([^\]]+)\]/.exec(rest);
	if (mm) {
		const [, requestId, moveType, player, sourceRef, targetRef, itemToken] = mm;
		if (itemToken === 'NONE') return null;
		// itemToken is usually `<class>_<entityId>`; the entityId lets us dedupe
		// "take out then put back" round-trips instead of double-counting them.
		const entityMatch = /^(.*)_(\d+)$/.exec(itemToken);
		return {
			type: 'queuedMove',
			timestamp, raw,
			requestId, moveType, player,
			sourceRef: sourceRef === 'INVALID' ? null : sourceRef,
			targetRef: targetRef === 'INVALID' ? null : targetRef,
			itemClass: classFromItemToken(itemToken),
			entityId: entityMatch ? entityMatch[2] : null
		};
	}

	// --- Request completion (success/fail) --------------------------------------
	// <Player Inventory Request Complete> Request[28528] for 'Morrschyvens' [...] Type[Store] Result[Succeed] Item[0] ...
	// The trailing Item[<id>] is the entity id assigned to the resulting instance
	// (0 when not applicable, e.g. plain QueryInventory/Store-from-hand).
	mm = /^<Player Inventory Request Complete> Request\[(\d+)\] for '([^']+)'.*?Type\[(\w+)\] Result\[(\w+)\] Item\[(\d+)\]/.exec(rest);
	if (mm) {
		const [, requestId, player, moveType, result, resultItem] = mm;
		return { type: 'requestComplete', timestamp, raw, requestId, player, moveType, result, resultEntityId: resultItem !== '0' ? resultItem : null };
	}

	// --- Equip (take item out of a container onto the body) ---------------------
	// <EquipItem> Request[11] equip from Inventory[718156344314:Container:0] Class[Drink_bottle_cruz_01_lux_a] ... PostAction[Carry]
	mm = /^<EquipItem> Request\[(\d+)\] equip from Inventory\[([^\]]+)\] Class\[([^\]]+)\]/.exec(rest);
	if (mm) {
		const [, requestId, sourceRef, itemClass] = mm;
		return { type: 'equip', timestamp, raw, requestId, sourceRef, itemClass };
	}

	// --- Unstow (spawn into world / into hand) -----------------------------------
	// <UnstowPendingEntities> Unstow Request[28529] for 'Morrschyvens' [...] finalized spawn of 'grin_multitool_01_mining_749868477932' [749868477932], 0 remaining
	mm = /^<UnstowPendingEntities> Unstow Request\[(\d+)\] for '([^']+)'.*?finalized spawn of '([^']+)' \[(\d+)\]/.exec(rest);
	if (mm) {
		const [, requestId, player, itemToken, instanceId] = mm;
		return { type: 'unstow', timestamp, raw, requestId, player, itemClass: classFromItemToken(itemToken), instanceId };
	}

	// --- Loadout enumeration on spawn --------------------------------------------
	// <AttachmentReceived> Player[Morrschyvens] Attachment[rsi_odyssey_undersuit_01_01_01_200000000219, rsi_odyssey_undersuit_01_01_01, 200000000219] Status[persistent] Port[Armor_Undersuit]
	mm = /^<AttachmentReceived> Player\[([^\]]+)\] Attachment\[([^,]+),\s*([^,]+),\s*([^\]]+)\] Status\[(\w+)\] Port\[([^\]]+)\]/.exec(rest);
	if (mm) {
		const [, player, , cleanClass, instanceId, status, port] = mm;
		return { type: 'attachment', timestamp, raw, player, itemClass: cleanClass.trim(), instanceId: instanceId.trim(), status, port };
	}

	// --- Location binding ---------------------------------------------------------
	// <RequestLocationInventory> Player[Morrschyvens] requested inventory for Location[RR_ARC_LEO]
	mm = /^<RequestLocationInventory> Player\[([^\]]+)\] requested inventory for Location\[([^\]]+)\]/.exec(rest);
	if (mm) {
		const [, player, locationCode] = mm;
		return { type: 'location', timestamp, raw, player, locationCode };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Ledger reduction: raw events -> net current state
// ---------------------------------------------------------------------------

/**
 * Reduce a stream of parsed events (already sorted by timestamp) into a
 * ledger of { class, containerRef } -> current believed quantity, tagged
 * with best-known location and contributing raw lines / event ids.
 *
 * Entity-id residency tracking: whenever we know the specific entity id
 * behind a move (Store/Interaction completions carry one in their trailing
 * Item[<id>] field), we track "this entity currently lives in container X"
 * so that a later Store of the SAME entity into the SAME container is a
 * no-op rather than a phantom +1 (e.g. take a drink out of a locker, look
 * at it, put it back — should net to zero, not +1). If the entity resides
 * somewhere else, storing it elsewhere is a true transfer: decrement the
 * old container, increment the new one. This only applies where we have a
 * concrete entity id; class-only bookkeeping (no id available) falls back
 * to naive +1/-1 deltas.
 */
function reduceLedger(events) {
	// state[class||containerRef] = { class, containerRef, quantity, locationCode, lastSeen, eventIds:Set }
	const state = new Map();
	// entityId -> containerRef currently believed to hold it ('worn' = on the body, not a container)
	const entityResidence = new Map();
	// wornPortRef -> entityId currently occupying that body port. A body port is a
	// singleton slot: on respawn/relog, persistent gear re-announces on the SAME
	// port with a BRAND NEW entity id (the character instance was recreated), which
	// would otherwise look like 3 separate tractor-beam-in-a-holster items instead
	// of 1. We evict whatever previously occupied a port before moving the new
	// entity in, so re-announcements replace rather than accumulate.
	const portOccupant = new Map();
	// pending queued moves, keyed by requestId, until we see a matching completion
	const pendingByRequest = new Map();
	// most-recently-seen location code (temporal correlation)
	let currentLocation = null;
	// containerRef -> last known location, updated as we go (most-recent-location-wins)
	const containerLocation = new Map();

	let player = null;
	let gameVersion = null;
	let sessionStarts = [];
	let earliestTs = null;
	const eventHashSet = new Set();

	function hashLine(raw) {
		return createHash('sha256').update(raw, 'utf8').digest('hex');
	}

	function touch(cls, containerRef, delta, timestamp, requestId, raw) {
		const key = `${cls}||${containerRef}`;
		const loc = containerLocation.get(containerRef) ?? currentLocation ?? null;
		let entry = state.get(key);
		if (!entry) {
			entry = { class: cls, containerRef, quantity: 0, locationCode: loc, lastSeen: timestamp, eventIds: new Set() };
			state.set(key, entry);
		}
		entry.quantity = Math.max(0, entry.quantity + delta);
		entry.locationCode = loc ?? entry.locationCode;
		entry.lastSeen = timestamp;
		if (requestId != null) entry.eventIds.add(String(requestId));
		if (raw) eventHashSet.add(hashLine(raw));
		// Debiting an item never seen credited should no-op at the source (clamped
		// at zero) rather than going negative; drop zero-quantity rows entirely so
		// they never surface in the output.
		if (entry.quantity <= 0) state.delete(key);
	}

	/**
	 * Move a known entity (by id) from wherever it currently resides to
	 * `targetRef` (or nowhere, if targetRef is null — e.g. equipped/dropped).
	 * No-ops if the entity is already resident at targetRef.
	 */
	function moveEntity(cls, entityId, targetRef, timestamp, requestId, raw) {
		const prevRef = entityResidence.get(entityId) ?? null;
		if (prevRef === targetRef) return; // already there — no-op (e.g. take out, put back)
		if (prevRef) {
			touch(cls, prevRef, -1, timestamp, requestId, raw);
			// If this entity was occupying a body port, that port is now empty —
			// clear the stale occupant record so a later re-announcement on the
			// same port (different entity) doesn't wrongly evict THIS one again.
			if (prevRef.includes(':Worn:') && portOccupant.get(prevRef)?.entityId === entityId) {
				portOccupant.delete(prevRef);
			}
		}
		if (targetRef) touch(cls, targetRef, 1, timestamp, requestId, raw);
		if (targetRef) entityResidence.set(entityId, targetRef);
		else entityResidence.delete(entityId);
	}

	for (const ev of events) {
		if (!earliestTs || ev.timestamp < earliestTs) earliestTs = ev.timestamp;

		switch (ev.type) {
			case 'gameVersion':
				gameVersion = ev.version;
				break;

			case 'sessionStart':
				sessionStarts.push({ start: ev.timestamp, file: ev.sourceFile ?? 'Game.log' });
				break;

			case 'location':
				player = player ?? ev.player;
				currentLocation = ev.locationCode;
				break;

			case 'queuedMove':
				player = player ?? ev.player;
				// Bind target/source container to the currently-known location
				if (ev.targetRef) containerLocation.set(ev.targetRef, currentLocation ?? containerLocation.get(ev.targetRef) ?? null);
				if (ev.sourceRef) containerLocation.set(ev.sourceRef, currentLocation ?? containerLocation.get(ev.sourceRef) ?? null);
				pendingByRequest.set(ev.requestId, ev);
				break;

			case 'requestComplete': {
				const pend = pendingByRequest.get(ev.requestId);
				if (!pend) break;
				pendingByRequest.delete(ev.requestId);
				if (ev.result !== 'Succeed') break; // failed request never landed

				// Prefer the entity id straight off the queued Item[<class>_<id>] token;
				// fall back to the completion line's trailing Item[<id>] field.
				const entityId = pend.entityId ?? ev.resultEntityId ?? null;

				if (pend.moveType === 'Store' || pend.moveType === 'Move') {
					if (entityId) {
						// Entity-id residency: correctly no-ops round-trips and
						// transfers between containers instead of blind +1/-1.
						moveEntity(pend.itemClass, entityId, pend.targetRef, ev.timestamp, ev.requestId, pend.raw);
					} else {
						// No concrete entity id available — fall back to naive deltas.
						if (pend.targetRef) touch(pend.itemClass, pend.targetRef, 1, ev.timestamp, ev.requestId, pend.raw);
						if (pend.sourceRef) touch(pend.itemClass, pend.sourceRef, -1, ev.timestamp, ev.requestId, pend.raw);
					}
				}
				break;
			}

			case 'equip': {
				// Item leaves the source container (equipped onto the body / carried).
				// The resulting entity id is only known once the matching
				// requestComplete line lands, so stash this as a pending move too —
				// reuse the same queued-move machinery keyed by requestId.
				pendingByRequest.set(ev.requestId, {
					moveType: 'Store', itemClass: ev.itemClass,
					sourceRef: ev.sourceRef, targetRef: null,
					entityId: null, raw: ev.raw
				});
				break;
			}

			case 'unstow':
				// Spawn into the world / into hand — informational; we don't have a
				// container ref here so we don't add it to any container's ledger.
				// (Equip/Store events around it carry the actual container deltas.)
				eventHashSet.add(hashLine(ev.raw));
				break;

			case 'attachment':
				player = player ?? ev.player;
				if (ev.status === 'persistent') {
					// Loadout enumeration: gear currently worn/carried. We track this
					// under a synthetic "worn" container so it still surfaces to the
					// user, but it is NOT a stockpile-eligible container ref.
					const wornRef = `${ev.player}:Worn:${ev.port}`;
					const prevOccupant = portOccupant.get(wornRef);
					if (prevOccupant && prevOccupant.entityId !== ev.instanceId) {
						// Respawn/relog re-announced this port with a new entity id —
						// evict the stale occupant instead of stacking a duplicate.
						moveEntity(prevOccupant.itemClass, prevOccupant.entityId, null, ev.timestamp, null, null);
					}
					moveEntity(ev.itemClass, ev.instanceId, wornRef, ev.timestamp, null, ev.raw);
					portOccupant.set(wornRef, { entityId: ev.instanceId, itemClass: ev.itemClass });
				}
				break;
		}
	}

	// Backfill: a container's activity often precedes the first
	// <RequestLocationInventory> line for the session (the game logs the
	// player's *inventory query* separately from the *location* prompt, and
	// the two aren't always ordered the way you'd expect). Rather than leave
	// those containers permanently untagged, fall back to the LAST location
	// code seen anywhere in the parsed log for any container still missing
	// one — a reasonable "you were probably still there" heuristic for the
	// common single-location session, called out explicitly in the README.
	const lastKnownLocation = currentLocation;
	if (lastKnownLocation) {
		for (const entry of state.values()) {
			if (!entry.locationCode && !entry.containerRef.includes(':Worn:')) {
				entry.locationCode = lastKnownLocation;
			}
		}
	}

	return {
		player,
		gameVersion,
		sessionStarts,
		earliestTs,
		eventHashes: [...eventHashSet],
		items: [...state.values()]
			.filter((e) => e.quantity > 0)
			.map((e) => ({
				class: e.class,
				containerRef: e.containerRef,
				quantity: e.quantity,
				locationCode: e.locationCode,
				lastSeen: e.lastSeen,
				eventIds: [...e.eventIds]
			}))
	};
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/** Parse global.ini for item_Name<class>=Display Name lines (skip _short variants). */
function loadDisplayNames(iniPath) {
	const names = new Map();
	if (!iniPath || !existsSync(iniPath)) return names;
	const text = readFileSync(iniPath, 'utf8');
	for (const line of text.split(/\r?\n/)) {
		// item_Name<class>=Display Name   OR   item_Name_<class>=Display Name
		const m = /^item_Name_?([A-Za-z0-9_]+?)(?:_short)?=(.+)$/.exec(line.trim());
		if (!m) continue;
		if (/_short$/.test(line.trim().split('=')[0])) continue;
		const [, cls, display] = m;
		if (!names.has(cls)) names.set(cls, display.trim());
	}
	return names;
}

/** Fallback prettifier: split class on underscores, title-case, drop trailing numeric/size tokens. */
function prettifyClassName(cls) {
	// Cargo/storage containers often encode their capacity as a `<N>SCU` token
	// (e.g. Carryable_TBO_InventoryContainer_2SCU) — surface that directly
	// rather than mangling it through the generic prettifier below.
	const scuMatch = /(\d+)SCU$/i.exec(cls);
	if (scuMatch) {
		return `Stor-All ${scuMatch[1]} SCU box`;
	}

	const tokens = cls.split('_').filter(Boolean);
	// drop trailing tokens that are purely numeric or look like size/version codes (e.g. "01", "02a")
	while (tokens.length > 1 && /^\d+[a-z]?$/i.test(tokens[tokens.length - 1])) {
		tokens.pop();
	}
	return tokens
		.map((t) => t.charAt(0).toUpperCase() + t.slice(1))
		.join(' ');
}

function displayNameFor(cls, nameMap) {
	if (nameMap.has(cls)) return nameMap.get(cls);
	return prettifyClassName(cls);
}

// ---------------------------------------------------------------------------
// File discovery / reading
// ---------------------------------------------------------------------------

// Memory safety: the parser uses readFileSync (whole file in memory at once).
// Normal Game.log files are well under 10MB; refuse anything pathological.
const MAX_LOG_FILE_BYTES = 200 * 1024 * 1024; // 200MB

function readLogFile(path) {
	const size = statSync(path).size;
	if (size > MAX_LOG_FILE_BYTES) {
		console.warn(`WARNING: skipping ${path} — ${(size / 1024 / 1024).toFixed(0)}MB exceeds the ${MAX_LOG_FILE_BYTES / 1024 / 1024}MB safety limit for a single log file.`);
		return [];
	}
	const text = readFileSync(path, 'utf8');
	return text.split(/\r?\n/);
}

/** First ISO-8601 timestamp found in a log file's opening lines, or null. */
function firstTimestampIn(path) {
	if (statSync(path).size > MAX_LOG_FILE_BYTES) return null;
	const text = readFileSync(path, 'utf8');
	const lines = text.split(/\r?\n/, 50);
	for (const line of lines) {
		const m = /^<(\d{4}-\d{2}-\d{2}T[^>]+)>/.exec(line);
		if (m) return m[1];
	}
	return null;
}

/**
 * Find every Game*.log in SC's `logbackups` directory, ordered oldest-first
 * by the FIRST TIMESTAMP INSIDE each file — filename/mtime ordering is not
 * reliable (backups can be renamed/copied and lose their original mtime).
 * Since quantity deltas clamp at zero, processing out of order can corrupt
 * net state, so correct chronological ordering matters here.
 */
function findBackupLogs(dir) {
	if (!dir || !existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^Game.*\.log$/i.test(f))
		.map((f) => join(dir, f))
		.map((p) => ({ path: p, ts: firstTimestampIn(p) ?? '' }))
		.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
		.map((e) => e.path);
}

/**
 * Returns true if `path` exists and looks like a sync file THIS script
 * produced (parses as JSON with a `format` starting `starloot-sync/`).
 * Anything else (missing file, garbage, a user's unrelated file that happens
 * to share the name) is treated as "not ours" — we must never clobber it.
 */
function looksLikeOurSyncFile(path) {
	if (!existsSync(path)) return false;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return typeof parsed?.format === 'string' && parsed.format.startsWith('starloot-sync/');
	} catch {
		return false;
	}
}

/**
 * Pick a safe output path: if `path` doesn't exist, or exists and already
 * looks like one of our own sync files (safe to overwrite — that's the
 * whole point of re-running the tool), use it as-is. Otherwise (some other
 * file is sitting there) fall back to `<name>-2.json`, `<name>-3.json`, etc.
 */
function pickSafeOutputPath(path) {
	if (!existsSync(path) || looksLikeOurSyncFile(path)) return path;
	const dir = dirname(path);
	const base = basename(path).replace(/\.json$/i, '');
	for (let n = 2; n < 1000; n++) {
		const candidate = join(dir, `${base}-${n}.json`);
		if (!existsSync(candidate) || looksLikeOurSyncFile(candidate)) return candidate;
	}
	// Extremely unlikely fallback — timestamped, guaranteed not to collide.
	return join(dir, `${base}-${Date.now()}.json`);
}

/**
 * Write the sync file safely: resolve a non-clobbering path, write to a
 * `.tmp` sibling, then rename over the target. Guarantees a crash or
 * interrupted write never leaves a partial/corrupt output file in place —
 * the rename is atomic on both Windows and POSIX filesystems.
 */
function writeSyncFileSafely(requestedPath, sync) {
	const targetPath = pickSafeOutputPath(requestedPath);
	const tmpPath = `${targetPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(sync, null, 2));
	renameSync(tmpPath, targetPath);
	return targetPath;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function parseFiles(filePaths, sinceIso) {
	const events = [];
	const sessionsSeen = [];
	const since = sinceIso ? new Date(sinceIso).toISOString() : null;

	for (const filePath of filePaths) {
		verboseLog(`[verbose] Parsing file: ${filePath}`);
		const lines = readLogFile(filePath);
		let sawSessionStart = false;
		const eventsBefore = events.length;
		// per-category event counts for this file, for --verbose progress output
		const categoryCounts = {};
		for (const line of lines) {
			const ev = parseLine(line);
			if (!ev) continue;
			if (since && ev.timestamp < since) continue;
			if (ev.type === 'sessionStart') {
				sessionsSeen.push({ start: ev.timestamp, file: basename(filePath) });
				sawSessionStart = true;
				continue;
			}
			categoryCounts[ev.type] = (categoryCounts[ev.type] ?? 0) + 1;
			events.push(ev);
		}
		if (!sawSessionStart && events.length) {
			// No explicit header found (e.g. a fixture snippet) — still record the file.
			sessionsSeen.push({ start: events[0]?.timestamp ?? null, file: basename(filePath) });
		}
		if (verboseEnabled) {
			const eventsParsed = events.length - eventsBefore;
			verboseLog(`[verbose]   lines: ${lines.length}, events: ${eventsParsed}`);
			const categorySummary = Object.entries(categoryCounts)
				.map(([type, count]) => `${type}=${count}`)
				.join(', ');
			verboseLog(`[verbose]   by category: ${categorySummary || '(none)'}`);
		}
	}

	events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
	return { events, sessions: sessionsSeen };
}

function buildSyncFile({ log, backups, ini, since }) {
	const filePaths = [];
	if (backups) filePaths.push(...findBackupLogs(backups));
	if (log) filePaths.push(log);
	if (filePaths.length === 0) {
		throw new Error('No log files to parse — pass --log <path> and/or --backups <dir>.');
	}

	const { events, sessions } = parseFiles(filePaths, since);
	const ledger = reduceLedger(events);
	const nameMap = loadDisplayNames(ini);

	const items = ledger.items.map((it) => ({
		class: it.class,
		displayName: displayNameFor(it.class, nameMap),
		quantity: it.quantity,
		containerRef: it.containerRef,
		locationCode: it.locationCode,
		lastSeen: it.lastSeen,
		eventIds: it.eventIds
	}));

	return {
		format: FORMAT,
		companionVersion: COMPANION_VERSION,
		generatedAt: new Date().toISOString(),
		player: ledger.player ?? null,
		gameVersion: ledger.gameVersion ?? null,
		sessions: sessions.length ? sessions : (ledger.sessionStarts.length ? ledger.sessionStarts : []),
		trackingSince: ledger.earliestTs ?? null,
		items,
		eventHashes: ledger.eventHashes
	};
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
	const fixturePath = join(__dirname, 'fixtures', 'sample-lines.log');
	if (!existsSync(fixturePath)) {
		console.error(`Self-test fixture not found: ${fixturePath}`);
		process.exit(1);
	}

	const { events } = parseFiles([fixturePath], null);
	const ledger = reduceLedger(events);

	const failures = [];

	function assert(cond, msg) {
		if (!cond) failures.push(msg);
	}

	assert(ledger.player === 'Morrschyvens', `expected player Morrschyvens, got ${ledger.player}`);
	assert(ledger.gameVersion === '4.9.188.23497', `expected gameVersion 4.9.188.23497, got ${ledger.gameVersion}`);

	const tractorBeam = ledger.items.find((i) => i.class === 'grin_multitool_01_tractorbeam' && i.containerRef === '718156344314:Container:0');
	assert(!!tractorBeam, 'expected tractor-beam multitool stored in 718156344314:Container:0');
	assert(tractorBeam && tractorBeam.locationCode === 'RR_ARC_LEO', `expected tractor-beam locationCode RR_ARC_LEO, got ${tractorBeam?.locationCode}`);
	assert(tractorBeam && tractorBeam.quantity === 1, `expected tractor-beam quantity 1, got ${tractorBeam?.quantity}`);

	assert(ledger.eventHashes.length > 0, 'expected at least one contributing event hash');

	const persistentAttachments = ledger.items.filter((i) => i.containerRef.includes(':Worn:'));
	assert(persistentAttachments.length > 0, 'expected at least one persistent loadout attachment in the fixture');

	if (failures.length) {
		console.error('SELF-TEST FAILED:');
		for (const f of failures) console.error(`  - ${f}`);
		process.exit(1);
	}

	console.log('SELF-TEST PASSED');
	console.log(`  player: ${ledger.player}`);
	console.log(`  gameVersion: ${ledger.gameVersion}`);
	console.log(`  items tracked: ${ledger.items.length}`);
	console.log(`  event hashes: ${ledger.eventHashes.length}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Interactive, no-args ("double-click") mode: auto-locate everything we can,
 * fall back to prompting on stdin, then keep the console window open with a
 * "Press Enter to exit" prompt so results are readable before it closes.
 * This is the ONLY mode that prompts or waits — every flag-driven invocation
 * (including --self-test, used by CI) behaves exactly as before, synchronously,
 * with no stdin interaction.
 */
async function runInteractiveMode() {
	// The whole interactive flow is wrapped in try/catch: a double-clicked .exe
	// has no visible stack trace to show anyone useful, and an unhandled crash
	// closes the window before the user can read anything. Any failure here
	// prints one friendly line and still waits for Enter.
	try {
		console.log('StarLoot Companion\n');
		if (verboseEnabled) console.log(`Version: ${COMPANION_VERSION}\n`);

		let log = autoLocateGameLog();
		if (log) {
			console.log(`Found Game.log: ${log}`);
		} else {
			console.log("Couldn't automatically find your Game.log.");
			console.log('It is usually at a path like:');
			console.log('  C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log\n');
			log = await promptStdin('Paste the full path to your Game.log: ');
		}

		if (!log || !existsSync(log)) {
			console.error(`\nCouldn't find a log file at: ${log || '(empty)'}`);
			console.error('Double-check the path and try again.');
			process.exitCode = 1;
			return;
		}

		const backups = autoLocateBackups(log);
		if (backups) console.log(`Found logbackups: ${backups}`);

		const ini = autoLocateIni(log);
		if (ini) console.log(`Found global.ini (for nicer item names): ${ini}`);

		console.log('\nReading log...');
		const sync = buildSyncFile({ log, backups, ini, out: 'starloot-sync.json' });
		const writtenPath = writeSyncFileSafely('starloot-sync.json', sync);

		console.log(`\nWrote ${writtenPath} in ${process.cwd()}`);
		console.log(`  player: ${sync.player ?? '(unknown)'}`);
		console.log(`  gameVersion: ${sync.gameVersion ?? '(unknown)'}`);
		console.log(`  items: ${sync.items.length}`);
		const locations = new Set(sync.items.map((i) => i.locationCode).filter(Boolean));
		console.log(`  locations: ${locations.size}`);
		console.log(`\nUpload ${basename(writtenPath)} into StarLoot's personal dashboard (Import) to continue.`);
	} catch (err) {
		appendErrorLog(err, 'runInteractiveMode');
		console.error(`\nSomething went wrong: ${err instanceof Error ? err.message : String(err)}`);
		console.error('No output file was written. Nothing on your system was changed.');
		console.error(`Details were saved to: ${ERROR_LOG_PATH}`);
		process.exitCode = 1;
	} finally {
		await waitForEnterToExit();
	}
}

function runFlagDrivenMode(args) {
	if (!args.log && !args.backups) {
		console.error('ERROR: --log <path> (and/or --backups <dir>) is required.\n');
		printHelp();
		process.exit(1);
	}
	if (args.log && !existsSync(args.log)) {
		console.error(`ERROR: log file not found: ${args.log}`);
		process.exit(1);
	}

	const sync = buildSyncFile(args);
	const writtenPath = writeSyncFileSafely(args.out, sync);

	console.log(`Wrote ${writtenPath}`);
	console.log(`  player: ${sync.player ?? '(unknown)'}`);
	console.log(`  gameVersion: ${sync.gameVersion ?? '(unknown)'}`);
	console.log(`  sessions: ${sync.sessions.length}`);
	console.log(`  trackingSince: ${sync.trackingSince ?? '(unknown)'}`);
	console.log(`  items: ${sync.items.length}`);
	console.log(`  eventHashes: ${sync.eventHashes.length}`);
}

async function main() {
	const rawArgs = process.argv.slice(2);
	const args = parseArgs(rawArgs);
	verboseEnabled = !!args.verbose;

	// No flags at all (double-click / bare `node starloot-companion.mjs`) counts
	// as interactive; every other invocation (including --self-test, used by
	// CI) is flag-driven and must never block on stdin when it crashes.
	const isInteractive = rawArgs.length === 0;
	installCrashHandlers(isInteractive);

	if (args.help) {
		printHelp();
		return;
	}

	if (args.selfTest) {
		runSelfTest();
		return;
	}

	if (isInteractive) {
		await runInteractiveMode();
		return;
	}

	if (verboseEnabled) console.log(`StarLoot Companion v${COMPANION_VERSION}`);
	runFlagDrivenMode(args);
}

main();
