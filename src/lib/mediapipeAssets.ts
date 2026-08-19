/**
 * MediaPipe runtime and model versions, pinned deliberately.
 *
 * Two separate assets, with different supply stories:
 *
 *  1. The WASM runtime ships inside the @mediapipe/tasks-vision npm package.
 *     `npm run fetch-assets` copies it into public/mediapipe/wasm/, so it is
 *     served from our own origin and its version is whatever package.json pins
 *     (an exact version, not a caret range — a patch bump to a 11 MB WASM blob
 *     is not something that should land silently).
 *
 *  2. The hand_landmarker.task model is NOT in the npm package. `npm run
 *     fetch-assets` downloads it into public/models/. It is deliberately not
 *     committed: it is a ~7.5 MB Google-published binary and vendoring someone
 *     else's model into this repository is a licensing decision for the owner,
 *     not for the build script.
 *
 * If the model has not been fetched, the app falls back to the pinned URL
 * below, which means a runtime network request to storage.googleapis.com on
 * first load. That is a real dependency and the README says so plainly rather
 * than describing the app as fully offline.
 */

/** Version of @mediapipe/tasks-vision. Must match package.json exactly. */
export const MEDIAPIPE_VERSION = '0.10.35';

/**
 * Model revision, from the MediaPipe model card URL. Pinned to a specific
 * revision ('1') rather than 'latest' so the model cannot change underneath a
 * release without a code change.
 */
export const HAND_MODEL_REVISION = '1';

/** Served from our own origin by fetch-assets. */
export const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;

export const LOCAL_HAND_MODEL_URL = `${import.meta.env.BASE_URL}models/hand_landmarker.task`;

/** Used only when the local model is absent. Version-pinned, never 'latest'. */
export const HAND_MODEL_FALLBACK_URL =
  `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/${HAND_MODEL_REVISION}/hand_landmarker.task`;
