/**
 * ZAO - Local Model Import Tool
 *
 * llama.rn's initLlama() needs a real filesystem path it can open directly
 * with native file I/O - it cannot open a content:// URI (Android's
 * Storage Access Framework handle for a folder the person picks via the
 * system folder picker). The person's model folder here
 * (/storage/416D-1601/Model/, an SD card path) is only reachable through
 * that SAF picker - Termux/JS has no direct path access to it - so a
 * one-time COPY step is required: grant SAF access once, copy the exact
 * GGUF files into the app's own private storage
 * (FileSystem.documentDirectory, a real file:// path), and have llama.rn
 * load from there from then on.
 *
 * This mirrors the existing filesystem tool's SAF pattern
 * (src/services/filesystem/filesystemTool.js's requestAccess/
 * getGrantedDirUri) but is a separate grant/URI, stored under
 * preferences.model_folder_saf_uri - deliberately NOT reusing
 * filesystem_saf_uri, since the person may grant a completely different
 * folder for general file operations vs. where their GGUF models live.
 *
 * Only the text-generation GGUF model is handled here (Qwen2.5-Coder-3B -
 * Qwen3-4B and Phi-4-mini-instruct have been fully removed). Whisper/
 * speech-to-text has also been removed entirely, so there is no separate
 * audio model to manage here either.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { getPreferences, updatePreferences } from '../../db/database';
import { LOCAL_MODELS } from '../../config/localModels';

const { StorageAccessFramework } = FileSystem;

const MODELS_DIR = `${FileSystem.documentDirectory}zao-models/`;

async function getGrantedModelDirUri() {
  const prefsResult = await getPreferences();
  return prefsResult?.data?.model_folder_saf_uri || null;
}

/**
 * Triggers Android's system folder picker so the person can grant access
 * to the folder their GGUF models live in (e.g. the SD card's Model/
 * folder). Must be called from a direct user tap (Settings button), same
 * restriction as the general filesystem tool's requestAccess().
 */
export async function requestModelFolderAccess() {
  try {
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) {
      return { success: false, data: null, error: { message: 'Folder access was not granted.' } };
    }
    await updatePreferences({ model_folder_saf_uri: permission.directoryUri });
    return { success: true, data: { directoryUri: permission.directoryUri }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not request folder access.' } };
  }
}

export async function hasModelFolderAccess() {
  const uri = await getGrantedModelDirUri();
  return !!uri;
}

/**
 * Checks which of the registered local models already exist in app-private
 * storage (copied and ready for initLlama), without touching the SAF
 * folder at all. Cheap, safe to call on every Settings screen mount.
 */
export async function getImportedModelStatus() {
  const status = {};
  for (const model of Object.values(LOCAL_MODELS)) {
    const localPath = `${FileSystem.documentDirectory}${model.localFilename}`;
    try {
      const info = await FileSystem.getInfoAsync(localPath);
      status[model.key] = { imported: !!info.exists, sizeBytes: info.exists ? info.size : 0, localPath };
    } catch (err) {
      status[model.key] = { imported: false, sizeBytes: 0, localPath };
    }
  }
  return status;
}

/**
 * Finds a file's SAF content:// URI by name inside the granted model
 * folder (non-recursive - the person should grant the folder that
 * directly contains the .gguf files, e.g. Model/ itself, not a parent).
 * Matches case-insensitively - Android SAF filenames are case-sensitive
 * on most filesystems, but people renaming/re-downloading GGUFs
 * (e.g. "Qwen2.5-coder..." vs "Qwen2.5-Coder...") is common enough that
 * an exact-case match caused real import failures for otherwise-correct
 * files. Prefers an exact-case match if one exists, falls back to
 * case-insensitive.
 */
async function findSourceFileUri(baseDirUri, filename) {
  const entries = await StorageAccessFramework.readDirectoryAsync(baseDirUri).catch(() => []);
  const target = `/${filename}`;
  const exact = entries.find((uri) => decodeURIComponent(uri).endsWith(target));
  if (exact) return exact;

  const targetLower = target.toLowerCase();
  return entries.find((uri) => decodeURIComponent(uri).toLowerCase().endsWith(targetLower)) || null;
}

/**
 * Copies one model's GGUF file from the granted SAF folder into app-private
 * storage, in base64-safe chunks handled internally by
 * StorageAccessFramework.readAsStringAsync/FileSystem - these are large
 * files (2-3GB range for Q4_K_M at this size class), so this can take a
 * while; callers should show a progress indicator and expect this to run
 * in the background, not block the UI thread's rendering.
 *
 * NOTE: expo-file-system's legacy API reads/writes base64 in memory. For
 * multi-GB GGUF files this is a real memory-pressure risk on some Android
 * devices. This uses FileSystem.copyAsync directly against the SAF source
 * URI where possible (a streaming native copy, not a JS base64 round-trip)
 * rather than read+write, specifically to avoid that.
 */
export async function importModel(modelKey, { onProgress } = {}) {
  const model = LOCAL_MODELS[modelKey];
  if (!model) {
    return { success: false, error: { message: `Unknown model: ${modelKey}` } };
  }

  const baseDirUri = await getGrantedModelDirUri();
  if (!baseDirUri) {
    return { success: false, error: { message: 'No model folder access granted yet. Grant access in Settings > Local Models first.' } };
  }

  try {
    const sourceUri = await findSourceFileUri(baseDirUri, model.sourceFilename);
    if (!sourceUri) {
      return {
        success: false,
        error: { message: `Could not find "${model.sourceFilename}" in the granted folder. Make sure the filename matches exactly.` },
      };
    }

    const dirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
    }

    const destPath = `${FileSystem.documentDirectory}${model.localFilename}`;

    // Remove any partial/previous copy first so a re-import always lands
    // clean rather than silently appending or leaving stale bytes.
    const existing = await FileSystem.getInfoAsync(destPath);
    if (existing.exists) {
      await FileSystem.deleteAsync(destPath, { idempotent: true });
    }

    onProgress?.({ status: 'copying', modelKey });

    // expo-file-system's copyAsync accepts a SAF content:// URI as `from`
    // on Android and streams natively - no JS-side base64 buffering of
    // the whole file.
    await FileSystem.copyAsync({ from: sourceUri, to: destPath });

    const finalInfo = await FileSystem.getInfoAsync(destPath);
    if (!finalInfo.exists || !finalInfo.size) {
      return { success: false, error: { message: `Copy of ${model.sourceFilename} appears to have failed - no file was written.` } };
    }

    onProgress?.({ status: 'done', modelKey, sizeBytes: finalInfo.size });

    return { success: true, data: { localPath: destPath, sizeBytes: finalInfo.size }, error: null };
  } catch (err) {
    console.error('[ModelImportTool] importModel failed:', err);
    return { success: false, error: { message: err?.message || `Could not import ${model.label}.` } };
  }
}

/**
 * Imports every currently-registered local model - now just
 * Qwen2.5-Coder-3B, the sole remaining model - in sequence. Whisper's
 * .safetensor is not part of this - it's a separate STT model to be wired
 * up later.
 */
export async function importAllModels({ onProgress } = {}) {
  const results = {};
  for (const modelKey of Object.keys(LOCAL_MODELS)) {
    results[modelKey] = await importModel(modelKey, { onProgress });
  }
  return results;
}

export async function deleteImportedModel(modelKey) {
  const model = LOCAL_MODELS[modelKey];
  if (!model) return { success: false, error: { message: `Unknown model: ${modelKey}` } };

  const destPath = `${FileSystem.documentDirectory}${model.localFilename}`;
  try {
    await FileSystem.deleteAsync(destPath, { idempotent: true });
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: { message: err?.message || `Could not delete ${model.label}.` } };
  }
}
