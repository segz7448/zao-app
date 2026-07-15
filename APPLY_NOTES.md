# ZAO - Phi-4-mini + Gemini migration patch

Drop-in replacement files. From your repo root:

```
cp -r ZAO-phi4-gemini-migration/src/* src/
```

Then, in Settings > Local Models, import the newly-registered
`Phi-4-mini-instruct-Q4_K_M.gguf` from your granted model folder (same
flow you already used for the other two models) - the app copies it into
app-private storage before it can be loaded.

## What changed

**Routing (`src/config/localModels.js`)**
- Phi-4-mini-instruct is now an active local model (was `PLANNED_MODELS`
  placeholder before).
- `classifyTask()` gained real reasoning/math keyword detection (it never
  actually returned `'reasoning'`/`'math'` before - those routing table
  entries were dead code).
- New routing: coding -> Qwen2.5-Coder-3B, reasoning/math -> Phi-4-mini,
  general/business -> Qwen3-4B.

**New: `src/providers/gemini.js`**
- Image generation, image editing, and vision/OCR via the Gemini API,
  using your own key (no trial key baked in - see `trialKeys.js`).
- Same `{success, data, error}` contract as every other provider/engine.
- `testConnection()` for Settings' "Test & Save" flow.

**`src/utils/orchestrator.js`**
- Image generation and vision/OCR are no longer hard "not supported" -
  they route to Gemini when a key is configured, else return a clear
  "add your Gemini key in Settings" error.
- New `editImageOrchestrated(instruction, sourceImage)` export for
  image-editing turns (not part of automatic `classifyTask` routing,
  since it needs an explicit source image).
- Generated/edited images are saved to
  `FileSystem.documentDirectory + 'zao-generated-images/'` and returned
  as `{ messageId, localImageUri }`, matching what
  `chatStore.js`'s `buildAssistantMessageFromResult` / `uploadGeneratedImage`
  already expected.

**`src/store/chatStore.js` / `src/screens/ChatScreen.js`**
- Stale comments claiming images are dropped/vision is unavailable are
  fixed - images are now forwarded to the orchestrator, and the image
  bubble is documented as rendering both user attachments and
  Gemini-generated/edited images (it already used the same
  `local_image_path` field for both, no rendering logic change needed).

**`src/screens/SettingsScreen.js` / `src/store/preferencesStore.js`**
- Added a Gemini row under Settings > API Keys (bug fix along the way:
  `ApiKeyRow` was hard-wired to always test against Hugging Face
  regardless of which provider it was rendering for - now dispatches by
  `provider` prop).
- Added a Gemini usage card + activity rows in the usage modal.

## Known pre-existing issues (not touched by this patch, flagging for you)

- `classifyTask()`'s coding-keyword list includes `'api'` as a bare
  substring, so phrases like "capital" trip a false-positive coding
  match. Same shape of bug likely affects other short substrings in that
  list.
- The GitHub tool-task keyword list only matches exact phrases like
  `"push to github"` - "push **this** to github" or similar rephrasings
  fall through to general chat instead of the tool orchestrator.

Neither blocks this migration; flagging in case you want a follow-up pass
on the classifier.
