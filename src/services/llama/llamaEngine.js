/**
 * ZAO - Local Llama Engine (llama.rn)
 *
 * Replaces src/providers/openrouter.js and src/providers/huggingface.js.
 * Every text model in ZAO is now a local GGUF file run via llama.rn's
 * initLlama()/completion() - there is no network call, no API key, and no
 * rate limit for this path.
 *
 * CONTEXT LIFECYCLE: initLlama() is expensive (loads a multi-GB model into
 * RAM) - this module keeps one LlamaContext per model key alive in memory
 * once loaded (a simple in-module cache, not re-created per message) and
 * only swaps contexts when the orchestrator asks for a different model key
 * than the one currently loaded. There's now only one local model
 * (Qwen2.5-Coder-3B - Qwen3-4B and Phi-4-mini-instruct have been fully
 * removed), so in practice this context is never swapped out once loaded,
 * but the swap-on-mismatch logic is left in place rather than special-cased
 * away, in case a second model is ever reintroduced.
 *
 * CONTRACT: sendMessage() intentionally mirrors the old provider adapters'
 * shape - { success, data: { content, toolCalls, raw }, error } - so
 * orchestrator.js, toolOrchestrator.js, and agentLoop.js need minimal
 * changes to call this instead of openrouter.js/huggingface.js.
 */

import { initLlama } from 'llama.rn';
import * as FileSystem from 'expo-file-system/legacy';
import { LOCAL_MODELS } from '../../config/localModels';

const ERROR_TYPES = {
  MODEL_NOT_IMPORTED: 'MODEL_NOT_IMPORTED',
  LOAD_FAILED: 'LOAD_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  INFERENCE_ERROR: 'INFERENCE_ERROR',
  UNKNOWN: 'UNKNOWN',
};

let currentContext = null;
let currentModelKey = null;
let loadingPromise = null; // guards against two concurrent loads racing each other

// Hard ceilings so a stuck native call surfaces as an error instead of
// leaving the UI on "Thinking..." forever. A cold load of a 2-2.5GB Q4_K_M
// gguf on a phone can legitimately take 1-2 minutes; completion() on a
// short reply should be well under a minute once the model is resident.
const LOAD_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const COMPLETION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ensures the given model is the one currently loaded in memory, loading
 * it (and releasing whatever was previously loaded) if needed. Safe to
 * call before every completion - it's a no-op if the requested model is
 * already resident.
 */
async function ensureModelLoaded(modelKey, onLoadProgress) {
  if (currentModelKey === modelKey && currentContext) {
    return { success: true, error: null };
  }

  // If another call is already mid-load, wait for it rather than starting
  // a second concurrent initLlama() for the same or a different model.
  if (loadingPromise) {
    await loadingPromise.catch(() => {});
    if (currentModelKey === modelKey && currentContext) {
      return { success: true, error: null };
    }
  }

  const model = LOCAL_MODELS[modelKey];
  if (!model) {
    return { success: false, error: { type: ERROR_TYPES.BAD_REQUEST, message: `Unknown model: ${modelKey}` } };
  }

  const localPath = `${FileSystem.documentDirectory}${model.localFilename}`;
  const info = await FileSystem.getInfoAsync(localPath).catch(() => ({ exists: false }));

  if (!info.exists) {
    return {
      success: false,
      error: {
        type: ERROR_TYPES.MODEL_NOT_IMPORTED,
        message: `${model.label} hasn't been imported yet. Go to Settings > Local Models and import it first.`,
      },
    };
  }

  loadingPromise = (async () => {
    // Release whatever's currently resident before loading the new one -
    // only one model fits comfortably in memory at a time on a phone.
    if (currentContext) {
      try {
        await currentContext.release();
      } catch (err) {
        console.error('[LlamaEngine] release() of previous context failed (continuing anyway):', err);
      }
      currentContext = null;
      currentModelKey = null;
    }

    console.log(`[LlamaEngine] Loading ${model.label} from ${localPath}...`);
    const startTime = Date.now();

    // use_mlock pins the whole model in physical RAM and refuses to let the
    // OS swap it out - on a phone that's already low on free memory (vs. a
    // server) this can cause the allocation to stall indefinitely rather
    // than fail fast, which is what silent multi-minute hangs typically
    // look like. use_mmap (on by default in llama.cpp) is enough to get
    // good performance without fighting the OS for locked pages.
    //
    // n_ctx: 1536 rather than 2048 - on a 4GB-RAM device (the actual
    // target here - see README "known gaps"), every 512 tokens of context
    // costs real KV-cache RAM on top of the ~1.9GB the Q4_K_M weights
    // already take. 1536 still comfortably covers a normal chat turn +
    // recent history + the memory-context block; if very long
    // conversations start getting cut off, that's the first knob to raise
    // back up, but only alongside more total device RAM headroom.
    //
    // n_threads: 3, not 4 - on a 4GB phone the "extended RAM" swap feature
    // (compressed RAM or flash-backed swap) some Android skins offer is
    // NOT a substitute for real RAM bandwidth; it's slow, and pinning all
    // available CPU threads to inference on a device this tight leaves
    // nothing for the OS/UI thread, which is what a lot of "it just sat on
    // Thinking forever" reports turn out to be - not a hung model call,
    // but the whole device starved of both RAM and CPU at once. 3 threads
    // is close to full utilization on most 4GB phones (typically 4-8 cores,
    // but only 2-4 of them are the fast "big" cores) while leaving a little
    // slack for the rest of the app to stay responsive during generation.
    //
    // n_parallel: 1 - llama.rn/llama.cpp defaults this to 8, which
    // reserves 8 separate KV-cache slots up front (for serving multiple
    // concurrent requests, which matters for a server, not a single-user
    // phone app running one conversation at a time). Explicitly setting 1
    // avoids allocating 7x more KV-cache RAM than ZAO will ever use.
    //
    // cache_type_k/v: 'q8_0' - quantizes the KV cache itself (not just the
    // model weights) instead of the f16 default, which roughly halves how
    // much RAM the conversation's running context costs as it grows, at a
    // small, generally not perceptible quality cost. This is the single
    // biggest lever here short of a smaller model.
    //
    // no_extra_bufts: true - skips llama.cpp's weight-repacking buffer
    // types, which speeds up prompt processing on some CPUs but costs
    // extra resident RAM to hold both the original and repacked weights.
    // Trading a bit of prompt-processing speed for lower peak memory is
    // the right tradeoff on a 4GB device.
    const context = await withTimeout(
      initLlama(
        {
          model: localPath,
          use_mlock: false,
          use_mmap: true,
          n_ctx: 1536,
          n_threads: 3,
          n_parallel: 1,
          cache_type_k: 'q8_0',
          cache_type_v: 'q8_0',
          no_extra_bufts: true,
          n_gpu_layers: 0, // Android Vulkan GPU inference in llama.cpp is still maturing - CPU for now
          use_jinja: true, // enables chat-template + tool-calling support
        },
        (progress) => {
          // Real 0-100 load progress from llama.rn's native side - lets the
          // UI show an actual percentage instead of a static spinner during
          // the 30-90+ second cold load a ~1.9GB model can take on a
          // low-RAM device (see ChatScreen.js's isModelLoading handling).
          onLoadProgress?.(progress);
        }
      ),
      LOAD_TIMEOUT_MS,
      `Timed out loading ${model.label} after ${LOAD_TIMEOUT_MS / 1000}s. The model file may be corrupted, or the device may be low on memory.`
    );

    console.log(`[LlamaEngine] ${model.label} loaded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    currentContext = context;
    currentModelKey = modelKey;
  })();

  try {
    await loadingPromise;
    return { success: true, error: null };
  } catch (err) {
    console.error('[LlamaEngine] initLlama failed:', err);
    currentContext = null;
    currentModelKey = null;
    return {
      success: false,
      error: { type: ERROR_TYPES.LOAD_FAILED, message: `Could not load ${model.label}: ${err?.message || 'unknown error'}` },
    };
  } finally {
    loadingPromise = null;
  }
}

/**
 * Converts ZAO's internal message shape ({role, content, images?}) plus
 * any already-OpenAI-shaped tool messages (role: 'tool', or an assistant
 * message carrying tool_calls - see src/services/toolOrchestrator.js) into
 * the {role, content} messages llama.rn's completion() expects. Vision
 * (image) input is not supported by these text-only GGUF models, so image
 * attachments are dropped here rather than silently mis-sent - callers
 * that need vision should already be short-circuited before reaching this
 * function (see orchestrator.js).
 */
function toLlamaMessage(message) {
  if (message.role === 'tool' || message.tool_calls) {
    return message;
  }
  const role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
  return { role, content: message.content || '' };
}

/**
 * @param {Array} history - internal message format history
 * @param {string} modelKey - one of config/localModels.js's MODEL_KEYS
 * @param {object} options - { maxTokens, temperature, tools, toolChoice, onLoadProgress }
 * @param {(progress: number) => void} [options.onLoadProgress] - called with 0-100 during
 *   a cold model load only (no-op if the model is already resident) - see ChatScreen.js's
 *   isModelLoading handling for why this matters on a low-RAM device.
 * @returns {Promise<{success, data: {content, toolCalls, raw}|null, error}>}
 */
export async function sendMessage(history, modelKey, options = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Empty conversation history' } };
  }

  const loadResult = await ensureModelLoaded(modelKey, options.onLoadProgress);
  if (!loadResult.success) {
    return { success: false, data: null, error: loadResult.error };
  }

  const messages = history.map(toLlamaMessage);

  try {
    const completionParams = {
      messages,
      n_predict: options.maxTokens || 1024,
      temperature: options.temperature ?? 0.7,
    };

    if (options.tools?.length) {
      completionParams.jinja = true;
      completionParams.tools = options.tools;
      completionParams.tool_choice = options.toolChoice || 'auto';
    }

    console.log(`[LlamaEngine] Running completion on ${modelKey}...`);
    const startTime = Date.now();

    const result = await withTimeout(
      currentContext.completion(completionParams),
      COMPLETION_TIMEOUT_MS,
      `Local model took longer than ${COMPLETION_TIMEOUT_MS / 1000}s to respond. It may be stuck - try again, or restart the app if this keeps happening.`
    );

    console.log(`[LlamaEngine] Completion finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    const toolCalls = result?.tool_calls?.length ? result.tool_calls : null;
    const responseText = result?.text || null;

    if (!responseText && !toolCalls) {
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: 'No content from local model.', raw: result } };
    }

    return {
      success: true,
      data: { content: responseText, toolCalls, raw: result },
      error: null,
    };
  } catch (err) {
    console.error('[LlamaEngine] completion failed:', err);
    return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: err?.message || 'Local model inference failed.' } };
  }
}

/**
 * Releases the currently loaded context, if any. Call when the app is
 * backgrounded for a long time or memory pressure is a concern - not
 * required for normal operation since ensureModelLoaded swaps contexts
 * automatically when a different model is needed.
 */
export async function releaseCurrentModel() {
  if (currentContext) {
    try {
      await currentContext.release();
    } catch (err) {
      console.error('[LlamaEngine] releaseCurrentModel failed:', err);
    }
  }
  currentContext = null;
  currentModelKey = null;
}

export function getLoadedModelKey() {
  return currentModelKey;
}

/**
 * Whether ANY model is currently resident in memory. The UI uses this to
 * show "Loading model… this can take a minute the first time" instead of
 * a plain "Thinking…" - on a low-RAM device the cold load of a ~1.9GB
 * Q4_K_M model can genuinely take 30-90+ seconds, and without this
 * distinction that looks identical to the app being stuck.
 */
export function isModelLoaded() {
  return !!currentContext;
}

/**
 * Real, non-simulated speed test. This does two genuinely separate things,
 * both against the actual resident LlamaContext - nothing here is a fixed
 * or estimated number:
 *
 *   1. context.bench(pp, tg, pl, nr) - calls straight into llama.cpp's own
 *      benchmark harness (the same one behind the `llama-bench` CLI tool
 *      upstream), which runs pp=512 prompt-processing tokens and
 *      tg=128 text-generation tokens for real and reports its own timed
 *      speedPp/speedTg in tokens/sec. This is not derived from a chat
 *      reply's length or timing - it's llama.cpp measuring its own raw
 *      throughput on this exact device, model, and current thread/context
 *      settings.
 *   2. A real completion() call with a small fixed prompt, so this
 *      function also doubles as an actual end-to-end engine check: if
 *      llama.rn's native module is missing/misconfigured, or the model
 *      file is corrupted, or the chat template fails to format, this
 *      step fails loudly with the genuine error rather than the bench
 *      numbers alone masking a broken chat path.
 *
 * Runs whatever model is currently loaded - if none is, this loads one
 * first via ensureModelLoaded() (reporting progress the same way
 * sendMessage() does), so calling this while nothing is resident yet
 * still measures the real cold-load time, not a cached warm one.
 *
 * @param {string} modelKey - one of config/localModels.js's MODEL_KEYS
 * @param {(progress: number) => void} [onLoadProgress]
 * @returns {Promise<{
 *   success: boolean,
 *   data: {
 *     wasAlreadyLoaded: boolean,
 *     loadTimeMs: number|null,   // null if the model was already resident
 *     promptTokensPerSec: number, // real, from llama.cpp's own bench()
 *     genTokensPerSec: number,    // real, from llama.cpp's own bench()
 *     chatCheckPassed: boolean,   // did a real completion() call actually return text?
 *     chatCheckTokensPerSec: number|null, // from timings.predicted_per_second on that real call
 *   }|null,
 *   error,
 * }>}
 */
export async function runSpeedTest(modelKey, onLoadProgress) {
  const wasAlreadyLoaded = currentModelKey === modelKey && !!currentContext;
  const loadStart = Date.now();

  const loadResult = await ensureModelLoaded(modelKey, onLoadProgress);
  if (!loadResult.success) {
    return { success: false, data: null, error: loadResult.error };
  }
  const loadTimeMs = wasAlreadyLoaded ? null : Date.now() - loadStart;

  try {
    // pp=512, tg=128, pl=1 (no parallel sequences - matches n_parallel: 1
    // in the context params above), nr=1 (single repetition - phones are
    // slow enough that 3+ repetitions, llama-bench's usual default, would
    // make this test itself take a very long time).
    const bench = await currentContext.bench(512, 128, 1, 1);

    // Real chat-path check: an actual completion() call through the exact
    // same code path sendMessage() uses, so a broken chat template, a
    // missing native binding, or a corrupted model shows up here as a
    // real failure rather than being silently skipped.
    let chatCheckPassed = false;
    let chatCheckTokensPerSec = null;
    try {
      const chatResult = await withTimeout(
        currentContext.completion({
          messages: [{ role: 'user', content: 'Reply with only the word: ready' }],
          n_predict: 16,
          temperature: 0.1,
        }),
        30000,
        'Chat check timed out after 30s.'
      );
      chatCheckPassed = !!(chatResult?.text || chatResult?.content);
      chatCheckTokensPerSec = chatResult?.timings?.predicted_per_second ?? null;
    } catch (chatErr) {
      console.error('[LlamaEngine] Speed test chat check failed:', chatErr);
      chatCheckPassed = false;
    }

    return {
      success: true,
      data: {
        wasAlreadyLoaded,
        loadTimeMs,
        promptTokensPerSec: bench.speedPp,
        genTokensPerSec: bench.speedTg,
        chatCheckPassed,
        chatCheckTokensPerSec,
      },
      error: null,
    };
  } catch (err) {
    console.error('[LlamaEngine] runSpeedTest failed:', err);
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.INFERENCE_ERROR, message: err?.message || 'Speed test failed to run.' },
    };
  }
}

export { ERROR_TYPES };
