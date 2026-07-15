/**
 * ZAO - Native Android Text-to-Speech
 *
 * Replaces the old Hugging Face-hosted TTS pipeline (XTTS-v2 with a
 * Qwen2.5-Omni-7B fallback). As of mid-2026, XTTS-v2, Qwen2.5-Omni-7B, and
 * every Qwen3-TTS variant are marked "not deployed by any Inference
 * Provider" on Hugging Face - meaning none of them can actually serve audio
 * through the free hosted Inference API right now, regardless of how the
 * request is built. Rather than keep chasing a moving target of which HF
 * model happens to be deployed this week, Read Aloud now uses the device's
 * own Android TTS engine via expo-speech.
 *
 * This has real advantages beyond "it works": it's instant (no network
 * round-trip), it works fully offline, it costs nothing, and it exposes
 * whatever voices/languages the user has installed on their own phone -
 * including any additional voice packs downloaded through Android's
 * system Settings > Text-to-speech output screen (Google's TTS engine
 * supports downloading extra languages/voices there; this module doesn't
 * need to know about that, it just asks the OS for whatever's available).
 *
 * expo-speech is a thin wrapper around the platform TTS API - on Android
 * that's android.speech.tts.TextToSpeech, so voice availability and quality
 * is exactly what the user's installed TTS engine (Google, Samsung, etc.)
 * provides.
 */

import * as Speech from 'expo-speech';
import * as IntentLauncher from 'expo-intent-launcher';

let currentUtteranceId = null;

/**
 * Returns the list of voices installed on the device, formatted for
 * display in a picker. Android voice identifiers are typically opaque
 * (e.g. "en-us-x-iol-local"), so this derives a readable label from the
 * language tag when no nicer name is available.
 * @returns {Promise<Array<{identifier: string, name: string, language: string, quality: string}>>}
 */
export async function getAvailableVoices() {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    return (voices || [])
      .map((v) => ({
        identifier: v.identifier,
        name: v.name || v.identifier,
        language: v.language,
        quality: v.quality || 'Default',
      }))
      // Group by language so the picker can show a sensible order.
      .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  } catch (err) {
    console.error('[AndroidTTS] getAvailableVoices failed:', err);
    return [];
  }
}

/**
 * Speaks the given text using the device's native TTS engine.
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.voiceIdentifier] - specific voice to use, from
 * getAvailableVoices(). Falls back to the system default voice if omitted
 * or no longer installed.
 * @param {number} [options.rate] - 0.1 (slowest) to 2.0 (fastest), 1.0 normal.
 * @param {number} [options.pitch] - 0.5 to 2.0, 1.0 normal.
 * @param {() => void} [options.onDone]
 * @param {() => void} [options.onStopped]
 * @param {(err: any) => void} [options.onError]
 * @returns {Promise<{success: boolean, error: object|null}>}
 */
export async function speak(text, options = {}) {
  const { voiceIdentifier, rate = 1.0, pitch = 1.0, onDone, onStopped, onError } = options;

  if (!text || !text.trim()) {
    return { success: false, error: { type: 'EMPTY_TEXT', message: 'Nothing to read aloud.' } };
  }

  // Stop anything currently speaking first - only one message should be
  // audible at a time (mirrors the old play/stop toggle behavior).
  await stop();

  return new Promise((resolve) => {
    const id = `zao-tts-${Date.now()}`;
    currentUtteranceId = id;

    Speech.speak(text, {
      voice: voiceIdentifier || undefined,
      rate,
      pitch,
      onDone: () => {
        if (currentUtteranceId === id) currentUtteranceId = null;
        onDone?.();
        resolve({ success: true, error: null });
      },
      onStopped: () => {
        if (currentUtteranceId === id) currentUtteranceId = null;
        onStopped?.();
        resolve({ success: true, error: null });
      },
      onError: (err) => {
        if (currentUtteranceId === id) currentUtteranceId = null;
        console.error('[AndroidTTS] speak error:', err);
        onError?.(err);
        resolve({
          success: false,
          error: { type: 'TTS_ERROR', message: 'Could not read this aloud on this device.' },
        });
      },
    });
  });
}

/**
 * Stops any speech currently in progress.
 */
export async function stop() {
  currentUtteranceId = null;
  try {
    await Speech.stop();
  } catch (err) {
    // Nothing was speaking - not a real error.
  }
}

/**
 * @returns {Promise<boolean>} true if the device is currently speaking.
 */
export async function isSpeaking() {
  try {
    return await Speech.isSpeakingAsync();
  } catch (err) {
    return false;
  }
}

/**
 * Voice Mode (the full-screen conversation UI) presents four friendly voice
 * "characters" rather than a raw list of opaque Android voice identifiers
 * (e.g. "en-us-x-iol-local" means nothing to most people). Since actual
 * timbre depends entirely on what's installed on the device, each preset
 * pairs a pitch/rate "character" with the best real installed voice that
 * matches its target gender lean - so "Buttery" and "Mellow" always sound
 * like distinct, real device voices rather than fake labels on the same
 * voice. Falls back to pitch/rate-only variation on devices with only one
 * installed voice.
 */
export const VOICE_PRESETS = [
  { key: 'buttery', label: 'Buttery', genderLean: 'male', pitch: 0.92, rate: 0.95 },
  { key: 'airy', label: 'Airy', genderLean: 'female', pitch: 1.08, rate: 1.05 },
  { key: 'mellow', label: 'Mellow', genderLean: 'male', pitch: 1.0, rate: 0.9 },
  { key: 'glass', label: 'Glass', genderLean: 'female', pitch: 1.15, rate: 1.0 },
];

// Very rough gender heuristic from common Android/Google TTS voice naming
// conventions (e.g. "en-us-x-iol-local" = female, "en-us-x-iom-local" =
// male, "en-US-Wavenet-D" = male, "en-US-Wavenet-F" = female). This is best-
// effort only - if it can't tell, the voice is treated as ungendered and
// distributed evenly across presets so all four still resolve to *some*
// installed voice rather than all collapsing onto the default.
function guessGenderLean(voice) {
  const id = (voice.identifier || '').toLowerCase();
  const name = (voice.name || '').toLowerCase();
  const femaleHints = ['female', '-iol-', '-iod-', '-iog-', 'wavenet-a', 'wavenet-c', 'wavenet-e', 'wavenet-f'];
  const maleHints = ['male', '-iom-', '-ioc-', '-ioe-', 'wavenet-b', 'wavenet-d'];
  if (femaleHints.some((h) => id.includes(h) || name.includes(h))) return 'female';
  if (maleHints.some((h) => id.includes(h) || name.includes(h))) return 'male';
  return null;
}

/**
 * Resolves the four friendly VOICE_PRESETS against whatever voices are
 * actually installed on this device, so Voice Mode's settings sheet can
 * show four tappable options that each genuinely sound different.
 * @param {Array} installedVoices - result of getAvailableVoices()
 * @returns {Array<{key, label, voiceIdentifier: string|null, pitch, rate}>}
 */
export function resolvePresetVoices(installedVoices) {
  if (!installedVoices || installedVoices.length === 0) {
    // No voices reported - every preset just uses the system default voice,
    // differentiated only by pitch/rate.
    return VOICE_PRESETS.map((p) => ({ ...p, voiceIdentifier: null }));
  }

  const englishFirst = [...installedVoices].sort((a, b) => {
    const aEn = (a.language || '').toLowerCase().startsWith('en') ? 0 : 1;
    const bEn = (b.language || '').toLowerCase().startsWith('en') ? 0 : 1;
    return aEn - bEn;
  });

  const byGender = { male: [], female: [], unknown: [] };
  for (const v of englishFirst) {
    const lean = guessGenderLean(v);
    byGender[lean || 'unknown'].push(v);
  }

  let unknownCursor = 0;
  return VOICE_PRESETS.map((preset) => {
    const pool = byGender[preset.genderLean];
    let chosen = pool.length > 0
      ? pool[Math.min(pool.length - 1, VOICE_PRESETS.filter((p) => p.genderLean === preset.genderLean).indexOf(preset))]
      : null;
    if (!chosen && byGender.unknown.length > 0) {
      chosen = byGender.unknown[unknownCursor % byGender.unknown.length];
      unknownCursor += 1;
    }
    if (!chosen) chosen = englishFirst[0];
    return { ...preset, voiceIdentifier: chosen?.identifier || null };
  });
}

/**
 * Opens Android's built-in "Text-to-speech output" settings screen, where
 * the user can change their system TTS engine, adjust its default speech
 * rate/pitch, and - most relevantly here - download additional
 * languages/voice packs for the installed engine. ZAO doesn't need to know
 * anything about what happens there; any newly-downloaded voice just shows
 * up the next time getAvailableVoices() is called.
 * @returns {Promise<{success: boolean}>}
 */
export async function openSystemTtsSettings() {
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.TTS_SETTINGS);
    return { success: true };
  } catch (err) {
    console.error('[AndroidTTS] openSystemTtsSettings failed:', err);
    return { success: false };
  }
}
