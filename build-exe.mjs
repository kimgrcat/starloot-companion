#!/usr/bin/env node
/**
 * StarLoot Companion — SEA (Single Executable Application) blob builder.
 *
 * WHY A SEPARATE CJS FILE:
 * Node's `--experimental-sea-config` / SEA tooling requires a CommonJS-loadable
 * entry point (it snapshots the module the way `require()` would load it, not
 * an ESM graph). `starloot-companion.mjs` is ESM (uses `import`/`import.meta`)
 * but is otherwise a single, zero-npm-dependency file that only touches
 * `node:*` builtins — no bundler is needed, just a mechanical import->require
 * rewrite. This script does that rewrite, writes the result to
 * `companion/dist/starloot-companion.cjs`, then drives the two-step SEA build
 * (`--experimental-sea-config` to produce the blob, then the caller injects
 * it into a node binary with postject).
 *
 * This file itself is intentionally plain CommonJS-compatible top-level code
 * (no import.meta) so it can be run directly with `node companion/build-exe.mjs`
 * on any platform without a build step of its own.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Read starloot-companion.mjs.
 *   2. Verify it only imports `node:*` builtins (fail loudly otherwise — a
 *      real npm dependency would need bundling, which this script doesn't do).
 *   3. Verify it contains exactly the known write surface: exactly one
 *      `writeFileSync(` call site (the sync-file output) and exactly one
 *      `appendFileSync(` call site (the crash-diagnostics log) — our
 *      read-only-except-known-writes invariant (see companion/README.md
 *      SAFETY section). This is a cheap static grep-based guard, not a proof,
 *      but it catches an accidental extra write path at build time.
 *   4. Rewrite the small number of ESM constructs it actually uses:
 *        - `import { a, b } from 'node:x'`      -> `const { a, b } = require('node:x')`
 *        - `dirname(fileURLToPath(import.meta.url))` -> `__dirname` (CJS provides this natively)
 *      This is a targeted, reviewable regex rewrite — NOT a general ESM->CJS
 *      transpiler. If the source file's import style changes, this script's
 *      rewrite step will fail its own verification pass (see step 5) rather
 *      than silently emit broken output.
 *   5. Write the result to companion/dist/starloot-companion.cjs and sanity
 *      check it (no leftover `import`/`import.meta` tokens, valid syntax via
 *      `node --check`, and — the strongest check — actually `require()` it in
 *      a child process and confirm `--self-test` passes against the CJS build
 *      too, not just the original .mjs).
 *   6. Write companion/dist/sea-config.json pointing at the .cjs.
 *   7. Run `node --experimental-sea-config` to produce companion/dist/sea-prep.blob.
 *
 * Injecting the blob into a node binary with postject (Windows or Linux) is
 * the CALLER's job (CI workflow steps, or scripts/sea-smoke-test.mjs locally)
 * — this script only produces the blob, so both deploy.yml and ci.yml can
 * reuse the exact same blob-build step.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dirname, 'starloot-companion.mjs');
const DIST_DIR = join(__dirname, 'dist');
const CJS_PATH = join(DIST_DIR, 'starloot-companion.cjs');
const SEA_CONFIG_PATH = join(DIST_DIR, 'sea-config.json');
const BLOB_PATH = join(DIST_DIR, 'sea-prep.blob');

function fail(msg) {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}

function main() {
	const src = readFileSync(SRC_PATH, 'utf8');

	// --- Step 2: verify only node: builtins are imported -----------------------
	const importLines = [...src.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"];?$/gm)];
	if (importLines.length === 0) fail('expected at least one `import` statement in starloot-companion.mjs — has the source changed shape?');
	for (const m of importLines) {
		const spec = m[1];
		if (!spec.startsWith('node:')) {
			fail(`starloot-companion.mjs imports a non-builtin module ('${spec}') — this build script only rewrites node: builtin imports to require(). A real dependency would need bundling first.`);
		}
	}

	// --- Step 3: exactly the known write surface --------------------------------
	// Read-only discipline invariant: the ONLY writes in the whole program are
	// the single sync-file output (via writeSyncFileSafely's temp-then-rename,
	// one writeFileSync( call site) and the crash-diagnostics log (via
	// appendErrorLog, one appendFileSync( call site — only ever touched if the
	// script crashes). If a future change adds another write path, this should
	// be a deliberate, reviewed decision — not something that slips in silently.
	const writeFileSyncCallCount = (src.match(/\bwriteFileSync\(/g) ?? []).length;
	if (writeFileSyncCallCount !== 1) {
		fail(`expected exactly 1 writeFileSync( call site in starloot-companion.mjs (found ${writeFileSyncCallCount}) — read-only discipline invariant violated. See README.md SAFETY section.`);
	}
	const appendFileSyncCallCount = (src.match(/\bappendFileSync\(/g) ?? []).length;
	if (appendFileSyncCallCount !== 1) {
		fail(`expected exactly 1 appendFileSync( call site in starloot-companion.mjs (found ${appendFileSyncCallCount}) — read-only discipline invariant violated (crash log write surface changed). See README.md SAFETY section.`);
	}

	// --- Step 4: ESM -> CJS rewrite ---------------------------------------------
	let cjs = src;

	// `import { a, b, c } from 'node:x';` -> `const { a, b, c } = require('node:x');`
	// (also handles single-line multi-import statements used in this file)
	cjs = cjs.replace(
		/^import\s+\{([^}]+)\}\s+from\s+(['"]node:[^'"]+['"]);?$/gm,
		'const {$1} = require($2);'
	);

	// The one import.meta usage in this file: __dirname via fileURLToPath.
	// CJS modules get `__dirname` natively from Node — just use it directly and
	// drop the now-unused fileURLToPath/dirname requires for that computation.
	// (dirname/fileURLToPath are still require()'d above for other uses in this
	// file if present; only this specific assignment line is special-cased.)
	const dirnameLine = "const __dirname = dirname(fileURLToPath(import.meta.url));";
	if (!cjs.includes(dirnameLine)) {
		fail('expected to find the __dirname assignment line to rewrite for CJS — starloot-companion.mjs structure changed; update build-exe.mjs\'s rewrite rule.');
	}
	cjs = cjs.replace(
		dirnameLine,
		'// __dirname is provided natively by Node in CommonJS modules — no rewrite needed.'
	);

	// Verify no *executable* import/import.meta remains. Comments are allowed to
	// still mention these tokens (e.g. explaining the rewrite itself) — strip
	// `//` line comments before checking so documentation doesn't trip this.
	const codeOnly = cjs
		.split('\n')
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n');
	if (/^\s*import\s/m.test(codeOnly) || codeOnly.includes('import.meta')) {
		fail('rewrite incomplete — output still contains an executable `import` statement or `import.meta`. Update the regex rules above to match the current source.');
	}

	mkdirSync(DIST_DIR, { recursive: true });
	writeFileSync(CJS_PATH, cjs);
	console.log(`Wrote ${CJS_PATH}`);

	// __dirname inside the .cjs resolves relative to WHERE THE FILE LIVES
	// (companion/dist/), same as the .mjs resolves relative to companion/. The
	// self-test looks up fixtures/sample-lines.log next to itself, so mirror
	// that layout here purely for this build-time check (the shipped .exe never
	// runs --self-test and doesn't need fixtures at all).
	cpSync(join(__dirname, 'fixtures'), join(DIST_DIR, 'fixtures'), { recursive: true });

	// --- Step 5: sanity-check the CJS build -------------------------------------
	execFileSync(process.execPath, ['--check', CJS_PATH], { stdio: 'inherit' });
	console.log('CJS build: syntax OK');

	execFileSync(process.execPath, [CJS_PATH, '--self-test'], { stdio: 'inherit' });
	console.log('CJS build: --self-test passed');

	// --- Steps 6-7: SEA config + blob -------------------------------------------
	const seaConfig = {
		main: 'starloot-companion.cjs',
		output: 'sea-prep.blob',
		disableExperimentalSEAWarning: true
	};
	writeFileSync(SEA_CONFIG_PATH, JSON.stringify(seaConfig, null, 2));
	console.log(`Wrote ${SEA_CONFIG_PATH}`);

	execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
		cwd: DIST_DIR,
		stdio: 'inherit'
	});

	if (!existsSync(BLOB_PATH)) fail(`expected ${BLOB_PATH} to exist after --experimental-sea-config`);
	console.log(`Wrote ${BLOB_PATH}`);
	console.log('\nSEA blob build complete. Inject into a node binary with postject, e.g.:');
	console.log('  npx postject <exe-path> NODE_SEA_BLOB companion/dist/sea-prep.blob \\');
	console.log('    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
}

main();
