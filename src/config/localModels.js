/**
 * ZAO - Local Model Configuration (llama.rn)
 *
 * Replaces config/models.js. ZAO now runs entirely on-device via llama.rn -
 * no OpenRouter, no Hugging Face, no API keys, no network dependency for
 * chat/coding/reasoning at all. There is no fallback chain because there's
 * nothing to fall back TO: this is a local GGUF file with no rate limit,
 * no quota, and no "other provider" to retry on - if the local model fails
 * to load or run, that's a real error to surface, not a signal to try
 * something else.
 *
 * The model file is NOT bundled with the app (a 2-4GB GGUF in the APK is a
 * non-starter). Instead, the person grants SAF access to their model
 * folder once (Settings > Local Models), ZAO copies the exact filename
 * below into its own app-private storage (see
 * src/services/llama/modelImportTool.js for why a copy step is required
 * rather than loading straight from the SAF folder), and llama.rn's
 * initLlama() loads from that private, real filesystem path.
 *
 * Routing (per explicit product requirement, no manual override):
 *   - Coding, general chat/business, reasoning and math -> all one model,
 *     Qwen2.5-Coder-3B-Instruct. Qwen3-4B and Phi-4-mini-instruct have been
 *     fully removed - there is now exactly one local text model, and it
 *     handles every task category.
 *   - Image generation/editing and vision/OCR -> Gemini API (cloud, user's
 *     own key - see src/providers/gemini.js). Not local: this is a
 *     deliberate exception to the "everything is local" architecture,
 *     because there is no on-device equivalent yet. OCR-shaped requests
 *     that are really about a PDF/DOCX/PPTX/XLSX file's structure (not a
 *     scanned image) are still handled by the existing local tool-calling
 *     path (pdf/docx/pptx/xlsx tools via the Qwen2.5-Coder router) - only
 *     genuine image-based OCR needs Gemini.
 *   - Speech-to-text (Whisper) has been removed entirely, along with the
 *     mic/waveform voice-input controls and Voice Mode screen. The
 *     composer is text/attachment-only now.
 */

// Filename exactly as it exists in the person's granted model folder
// (originally /storage/416D-1601/Model/, an SD card path only reachable
// through Android's SAF picker - see modelImportTool.js). This is the
// SOURCE filename looked up inside the granted SAF directory during
// import; LOCAL_MODEL_FILENAME below is the name it's copied to on-device.
export const SOURCE_FILENAMES = {
  qwen25_coder_3b: 'Qwen2.5-coder-3B-instruct-Q4_K_M.gguf',
};

// Where the model lives once imported, relative to FileSystem.documentDirectory
// (see llamaEngine.js / modelImportTool.js). Kept as a stable name distinct
// from the source filename so re-imports/overwrites are predictable even if
// the person renames the source file later.
export const LOCAL_MODEL_FILENAME = {
  qwen25_coder_3b: 'zao-models/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
};

export const MODEL_KEYS = {
  QWEN25_CODER_3B: 'qwen25_coder_3b',
};

// Display metadata for Settings screen.
export const LOCAL_MODELS = {
  [MODEL_KEYS.QWEN25_CODER_3B]: {
    key: MODEL_KEYS.QWEN25_CODER_3B,
    label: 'Qwen2.5 Coder 3B',
    description: 'Handles everything - chat, coding, reasoning, tool-calling (Q4_K_M)',
    sourceFilename: SOURCE_FILENAMES.qwen25_coder_3b,
    localFilename: LOCAL_MODEL_FILENAME.qwen25_coder_3b,
  },
};

// Nothing currently planned-but-not-downloaded. Kept as an empty export
// (rather than removed) so Settings' "planned models" section, if it
// iterates this, doesn't need a conditional import change later.
export const PLANNED_MODELS = {};

/**
 * Task classifier - unchanged in spirit from the old config/models.js, but
 * every text-generation category (coding, reasoning, math, general,
 * business) now maps to the single remaining local model,
 * Qwen2.5-Coder-3B-Instruct. Qwen3-4B and Phi-4-mini-instruct are gone, so
 * there's no more per-category model split - classifyTask() still detects
 * the categories below (kept for the tool-routing/browser-agent checks
 * upstream in orchestrator.js, and in case category-specific prompting is
 * wanted later), but FIXED_MODEL_ROUTE now points every one of them at the
 * same model key.
 *
 * NOTE: 'github' (tool-orchestrator tasks), 'browsing', 'imageGeneration'
 * and 'vision' categories from the old classifier still get detected here
 * for the tool-routing/browser-agent checks upstream in orchestrator.js.
 * imageGeneration and vision now route to Gemini (src/providers/gemini.js)
 * when the person has added their own Gemini API key in Settings, or
 * return a clear "add your Gemini key" error if not - see
 * src/utils/orchestrator.js.
 */
export function classifyTask(messageText = '') {
  const text = messageText.toLowerCase();

  const codingKeywords = [
    'code', 'build', 'app', 'function', 'debug', 'bug', 'component', 'api', 'script',
    'react', 'python', 'javascript', 'app development', 'web development', 'website',
    'frontend', 'backend', 'long context', 'refactor', 'compile', 'repository', 'repo',
  ];
  const reasoningMathKeywords = [
    'solve', 'proof', 'prove', 'theorem', 'equation', 'calculate', 'calculation',
    'math', 'maths', 'mathematics', 'algebra', 'calculus', 'geometry', 'derivative',
    'integral', 'probability', 'statistics', 'logic puzzle', 'logic problem',
    'riddle', 'step by step reasoning', 'think step by step', 'word problem',
    'brain teaser', 'chain of thought', 'reason through', 'reasoning problem',
  ];
  const toolTaskKeywords = [
    'push to github', 'push it to github', 'commit to github', 'create a repo',
    'create a repository', 'create a github repo', 'open a pull request',
    'create a pull request', 'open a pr', 'create a branch', 'github release',
    'upload to github', 'clone the repo', 'clone this repo',
    'zip this folder', 'zip the folder', 'extract this zip', 'unzip this',
    'create a folder', 'delete this file', 'delete this folder', 'move this file',
    'rename this file', 'rename this folder', 'save this to my phone',
    'save this to my device', 'save to storage', 'create these files',
    'make this a pdf', 'create a pdf', 'save as pdf', 'export as pdf',
    'merge these pdfs', 'merge pdfs', 'combine these pdfs', 'split this pdf',
    'split the pdf', 'create a word document', 'make this a word doc',
    'save as docx', 'create a docx', 'create a spreadsheet', 'save as xlsx',
    'create a xlsx', 'make this a spreadsheet', 'export as csv', 'save as csv',
    'create a csv', 'create a presentation', 'make a powerpoint',
    'create a pptx', 'save as pptx', 'make a slide deck', 'create a pitch deck',
  ];
  const browsingKeywords = [
    'search the web', 'search online', 'browse', 'go to', 'open this website', 'open this site',
    'visit this site', 'visit this url', 'look this up online', 'find on the web',
    'check the website', 'download the', 'latest release', 'current price of',
    'what does this website say', 'click on', 'fill out the form',
    'news today', 'today\'s news', 'latest news', 'what\'s happening', 'current events',
    'what happened today', 'recent news', 'breaking news',
  ];
  const imageGenerationKeywords = [
    'generate an image', 'generate image', 'create an image', 'create a picture',
    'draw a picture', 'draw an image', 'make an image', 'make a picture',
    'generate a picture', 'image of a', 'picture of a', 'draw me', 'paint me',
    'illustration of', 'render an image', 'image generation',
  ];
  const visionKeywords = ['photo', 'picture', 'screenshot', 'diagram', 'see this'];

  if (toolTaskKeywords.some((k) => text.includes(k))) return 'github';
  if (browsingKeywords.some((k) => text.includes(k))) return 'browsing';
  if (imageGenerationKeywords.some((k) => text.includes(k))) return 'imageGeneration';
  if (visionKeywords.some((k) => text.includes(k))) return 'vision';
  if (codingKeywords.some((k) => text.includes(k))) return 'coding';
  if (reasoningMathKeywords.some((k) => text.includes(k))) return 'reasoning';
  return 'general';
}

/**
 * Fixed model routing - the only routing table now. No fallback array,
 * because there's no second model to fall back to per category; a failure
 * is a real failure (model not loaded, out of memory, etc.) and should be
 * surfaced to the person as such. Every category maps to the same single
 * local model now that Qwen3-4B and Phi-4-mini-instruct have been removed.
 */
export const FIXED_MODEL_ROUTE = {
  coding: MODEL_KEYS.QWEN25_CODER_3B,
  general: MODEL_KEYS.QWEN25_CODER_3B,
  business: MODEL_KEYS.QWEN25_CODER_3B,
  reasoning: MODEL_KEYS.QWEN25_CODER_3B,
  math: MODEL_KEYS.QWEN25_CODER_3B,
};

export function getModelKeyForTask(taskCategory) {
  return FIXED_MODEL_ROUTE[taskCategory] || MODEL_KEYS.QWEN25_CODER_3B;
}

export function getModelDisplayList() {
  return Object.values(LOCAL_MODELS);
}
