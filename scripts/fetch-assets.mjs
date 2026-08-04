/**
 * Stage MediaPipe assets into public/ so they are served from our own origin.
 *
 *  - WASM runtime: copied from node_modules. Offline, deterministic, and
 *    guaranteed to match the pinned package version.
 *  - Hand landmarker model: downloaded from Google, because it is not
 *    distributed in the npm package.
 *
 * A failed model download is a warning, not an error: the app falls back to the
 * pinned remote URL at runtime, so a build without network access still
 * produces a working bundle. The README documents that fallback.
 *
 * Run with: npm run fetch-assets
 */

import { createRequire } from 'node:module';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Keep in sync with src/lib/mediapipeAssets.ts. */
const HAND_MODEL_REVISION = '1';
const MODEL_URL = `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/${HAND_MODEL_REVISION}/hand_landmarker.task`;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyWasm() {
  // The package's "exports" map does not expose ./package.json, so locate the
  // install directory via an entry it does export and walk up from there.
  const wasmEntry = require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.wasm');
  const source = dirname(wasmEntry);
  const target = join(root, 'public', 'mediapipe', 'wasm');

  if (!(await exists(source))) {
    console.error(`  wasm not found at ${source} — run npm install first.`);
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });

  const manifest = JSON.parse(await readFile(join(source, '..', 'package.json'), 'utf8'));
  console.log(`  wasm runtime  -> public/mediapipe/wasm  (tasks-vision ${manifest.version})`);
}

async function fetchModel() {
  const target = join(root, 'public', 'models', 'hand_landmarker.task');

  if (await exists(target)) {
    console.log('  hand model    -> already present, skipping download');
    return;
  }

  console.log(`  hand model    -> downloading revision ${HAND_MODEL_REVISION}…`);
  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`  hand model    -> public/models/hand_landmarker.task (${(bytes.length / 1e6).toFixed(1)} MB)`);
  } catch (error) {
    console.warn(`  hand model    -> download failed (${error.message}).`);
    console.warn('                   The app will fall back to the pinned Google URL at runtime.');
  }
}

console.log('\nStaging MediaPipe assets:');
await copyWasm();
await fetchModel();
console.log('');
