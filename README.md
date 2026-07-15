# ZAO

Fully on-device AI assistant for Android. Chat, coding, reasoning, and math
all run locally via `llama.rn` (llama.cpp) - no cloud API, no per-message
key, no rate limit, no network call for any of that, and no backend at
all. Beyond chat, ZAO also acts as an on-device agent: it can browse the
web, push code to GitHub, run real shell commands via Termux, and
create/read PDF/Word/Excel/PowerPoint files - all invoked automatically by
the local model, not through dedicated buttons.

There is no cloud dependency anywhere in this app. No Supabase, no Gemini,
no Hugging Face. Everything - chat, storage, files - lives on the device.

## Model in this project

| Model | Where it runs | Used for |
|---|---|---|
| **Qwen2.5 Coder 3B Instruct** (Q4_K_M) | Local, `llama.rn` | Everything: general chat, coding, reasoning, math, and as the tool-calling "router" for GitHub/filesystem/terminal/PDF/Office/browser-agent tasks |

One model handles every task category - there's no per-category split and
no manual model picker. Registered in code at `src/config/localModels.js`.

Image/camera/file attachments still work in the composer, but there is no
vision or image-generation model wired up - an attached image is stored
and shown in the chat bubble, not analyzed. Read Aloud (native Android TTS)
still works on assistant replies; there is no voice input (mic/Whisper) or
Voice Mode anymore.

## Architecture

```
src/
  db/database.js              SQLite layer - the ONLY database ZAO has now (no cloud
                               sync, no backup). Every function returns {success, data,
                               error}, never throws. Conversations, messages, preferences,
                               API key metadata, memory facts, usage events, model health.
  config/
    localModels.js             Single source of truth for the one local model: source/
                               local GGUF filename, classifyTask() (keyword-based task
                               detection, kept for tool-routing checks), and
                               FIXED_MODEL_ROUTE (every task category -> the same model
                               key, no manual override, no fallback chain).
  providers/
    adapterUtils.js             Shared timeout wrapper + error classification. No cloud
                               providers left to use it against right now, but kept as
                               the shape any future provider would follow.
  services/
    llama/
      llamaEngine.js              Local inference engine. Keeps one LlamaContext resident
                                 in memory and swaps it if a different model key is ever
                                 requested. sendMessage() returns the same
                                 {success, data, error} shape the old cloud adapters used.
      modelImportTool.js          One-time SAF folder grant (Settings > Local Models) +
                                 native streaming copy of the GGUF from wherever it lives
                                 (e.g. an SD card) into app-private storage, since
                                 initLlama() needs a real file:// path, not a content:// URI.
    toolOrchestrator.js           The "project manager" pattern: the local model sees
                               OpenAI-style tool schemas for GitHub, filesystem, PDF,
                               Office (docx/xlsx/pptx/csv), and Termux, decides which to
                               call and in what order, and the chat only ever shows a
                               running checklist ("Working... Created repo... Pushed to
                               GitHub"). The person never sees a "tools" button.
    github/githubTool.js          Real GitHub REST/Git Data API calls (create repo, read/
                               commit files, branches, PRs) using the person's own
                               Personal Access Token. Not the `git` binary - there's no
                               git available inside the RN runtime - this drives the same
                               end state (blob -> tree -> commit -> ref update) over HTTPS.
    filesystem/filesystemTool.js  Device-wide file operations (create/move/rename/delete/
                               zip/extract) under a folder the person grants once via
                               Android's Storage Access Framework - required because
                               Android 10+ blocks arbitrary path access outside SAF.
    terminal/terminalTool.js      Dispatches real shell commands to Termux via a native
                               module (see plugins/withTermuxRunCommand below) and returns
                               actual stdout/stderr/exit code - not a simulated shell. Also
                               used as the fallback tier for PDF/DOCX text extraction (see
                               "File handling" below).
    pdf/pdfTool.js                 Create/merge/split PDFs (pdf-lib, pure JS). No OCR -
                               reading a scanned/image PDF is a vision problem, and ZAO
                               has no vision model wired up right now.
    office/
      docxTool.js                  Create Word documents (docx library).
      xlsxTool.js                  Create spreadsheets + CSV (SheetJS-style, live formulas
                                  supported via `=`-prefixed cell values).
      pptxTool.js                  Create PowerPoint decks (pptxgenjs).
    documentExtraction.js         Reads PDF/DOCX/PPTX attachments. Tries the pure-JS
                               extractors in src/files/ first (free, instant, no setup);
                               if that fails or returns suspiciously little text, falls
                               back to Termux (pdftotext / python-docx) for PDF/DOCX,
                               since Termux is a real toolchain and can succeed where the
                               regex-based path can't. See "File handling" below.
    browserAgent/
      agentLoop.js                  The on-device browser agent's "brain" - an AgentSession
                                  is a stateful, resumable conversation (system prompt +
                                  every task + action/observation pairs) driven by the
                                  local model. No servers, no tunnels.
      BrowserAgentView.js /
      BrowserAgentPiP.js             The "hands" - the actual on-device WebView the agent
                                  controls, one persistent instance for the app's lifetime
                                  so a follow-up task picks up wherever the last one left
                                  off (open page, filled-in form, etc.). Captures a still
                                  JPEG per step, saved locally only (no cloud upload).
      domBridge.js                   Injects JS into the WebView to read/click/fill the
                                  live DOM and report back to agentLoop.js.
    memory/memoryEngine.js         Long-term, cross-conversation memory (name, preferences,
                               ongoing projects) - extracted in the background by the local
                               model after each turn, re-injected as a system message into
                               every future conversation. Toggle in Settings > Memory.
    tts/androidTts.js               Native Android text-to-speech (expo-speech) for the
                               Read Aloud message action - not a cloud TTS model, and not
                               tied to any voice-input feature.
    video/frameSampler.js            Extracts video frames (expo-video-thumbnails) - built
                               for future video-understanding use, not currently wired to
                               a model since the local model here is text-only.
    fileTypes.js / fileProcessor.js  Entry point for any attached file - routes to the right
                               extractor (text/CSV/ZIP/PDF/DOCX/PPTX), normalizes every
                               result into one shape, never throws.
    textExtraction.js / zipHandler.js  On-device plain text/CSV and ZIP extraction
                               (expo-file-system + papaparse / jszip, no server round-trip).
  files/
    pdfExtractor.js, officeExtractors.js  Pure-JS, on-device text extraction for PDF and
                               DOCX/PPTX - pattern/regex-based rather than a full parser
                               (see each file's docstring for exact limitations). This is
                               tier 1 in documentExtraction.js's extraction flow.
  utils/
    orchestrator.js                The one function the UI calls to send a message.
                               Checks for GitHub/tool tasks, then the browser agent
                               toggle, then falls through to normal local chat completion
                               via classifyTask() + FIXED_MODEL_ROUTE. Never throws.
    saveImageToGallery.js           Saves an attached image to the device photo gallery
                               via expo-media-library.
  store/
    chatStore.js                    Zustand store: messages, active conversation,
                               conversation list, sending state, browser-agent step
                               progress. Builds the assistant message row from whatever
                               the orchestrator returns.
    preferencesStore.js              Zustand store: theme, memory/browser-access toggles,
                               API key status (GitHub, browser router), SAF grants
                               (filesystem + local-model folder).
    themeStore.js                    Auto/Light/Dark preference, persisted to SQLite.
  screens/
    ChatScreen.js                    Main chat UI - message bubbles (including attached
                               images via local_image_path), composer, browser-agent step
                               list. No mic/waveform controls - text and attachments only.
    SettingsScreen.js                 Local Models (import/manage the GGUF), API Keys
                               (GitHub), Browser Agent, Memory, Usage & Activity.
    BrowserAgentScreen.js             Full-screen browser agent view.
  components/
    ErrorBoundary.js, SidebarDrawer.js, AttachmentSheet.js, MarkdownText.js,
    MessageActionMenu.js, MessageActions.js, Toast.js,
    ImageViewerModal.js         UI building blocks - see inline comments per file.
  theme/                        tokens.js (full light+dark palettes) + useTheme.js (the
                               hook every screen/component should pull colors from).

plugins/withTermuxRunCommand/    Expo config plugin: copies the native Kotlin
                               TermuxRunCommand module into the generated android/ project,
                               registers it in MainApplication, and adds the
                               com.termux.permission.RUN_COMMAND manifest permission -
                               regenerated correctly on every `expo prebuild`, no manual
                               Android Studio editing needed.
```

## The local model

Qwen2.5 Coder 3B Instruct (Q4_K_M quantization) runs through `llama.rn`,
which wraps llama.cpp. It is **not bundled with the app** - a multi-GB
model in the APK isn't practical - instead:

1. Grant folder access once in **Settings > Local Models** (Android's
   system folder picker, via Storage Access Framework - works even for a
   path like an SD card that JS can't otherwise reach directly).
2. Tap import. ZAO finds it by exact filename inside that folder, copies
   it into app-private storage (llama.rn needs a real `file://` path, not
   a `content://` URI), and it's ready to use offline forever after that.

No API key, no rate limit, no per-message cost - and no fallback chain,
either: if the model fails to load or respond, that's a real error
surfaced to the person, not something silently retried against another
provider (there isn't one).

## Browser agent

Toggle the composer's globe icon to let ZAO browse the web on request.
This is fully on-device: a real WebView (`BrowserAgentView.js`/
`BrowserAgentPiP.js`) that the local model reads/clicks/fills via injected
JS (`domBridge.js`), directed by a resumable `AgentSession`
(`agentLoop.js`) that persists across multiple tasks in the same
conversation. No backend, no tunnel, no self-hosted service required.

## Key design decisions

- **Fully local, fully offline**: every message is written to local
  SQLite immediately and stays there - there is no cloud sync, no backup,
  and no multi-device story. A device's `zao.db` is the only copy of its
  data.
- **No fallback chain for the local model**: it failing to load or
  respond is a real, surfaceable error - there's no other provider to
  silently retry.
- **Nothing throws uncaught**: `db/database.js`, `utils/orchestrator.js`,
  and the tool services all wrap every operation in try/catch and return
  a consistent `{success, data, error}` shape. Combined with the
  top-level `ErrorBoundary` in `App.js`, the app should never show a
  blank crash screen.
- **Icons: `@expo/vector-icons` only, never emoji or favicon-style
  glyphs**. Every icon (composer "+", camera/photos/files tiles, send,
  menu, settings gear, close, checkmarks, sparkles, attach clip, warning
  state, etc.) must be a proper icon component
  (`Ionicons`/`MaterialIcons`/`MaterialCommunityIcons`) with explicit
  `size` and `color` props from `useTheme()`. `@expo/vector-icons` ships
  bundled with `expo` already - no extra install needed.

## Setup

```bash
npm install
npx expo start          # dev server, scan QR with Expo Go for quick iteration
npx expo prebuild --platform android --clean   # generate native android/ project
```

APK builds happen via GitHub Actions on push to `main` (see
`.github/workflows/build-apk.yml`). It runs `expo prebuild` fresh every
time, so `android/` is gitignored and never committed.

After installing, import the local model (Settings > Local Models - see
"The local model" above) before expecting chat/coding/reasoning to work.

## Secure API key storage

The only user-provided credentials left are the GitHub Personal Access
Token and the Browser Router auth token, both stored via
`expo-secure-store` using Android Keystore (hardware-backed encryption on
most devices) rather than plain SQLite. The `api_keys` table in local
SQLite only holds non-sensitive metadata (which provider has a key,
whether it's user-provided, when it last changed) - the actual
`key_value` lives only in SecureStore. See `src/db/database.js`'s
`storeApiKey`/`getApiKey`/`deleteApiKey` comments for the full split.

## Theme system & navigation

Three-way theme preference - **Auto** (follows the phone's live system
setting), **Light**, or **Dark** - set in Settings > Appearance and
persisted to SQLite so it's sticky across restarts. `src/theme/tokens.js`
holds both full color palettes; `src/theme/useTheme.js` is the hook every
screen calls to get the resolved theme object.

Navigation is a hand-rolled sidebar drawer (`src/components/SidebarDrawer.js`),
built on React Native's `Animated` + `PanResponder` only - deliberately not
`react-navigation`, to avoid pulling in `react-native-gesture-handler` +
`reanimated` as additional native dependencies. Shows conversation history
(newest first, auto-titled), a "New chat" action, and a Settings gear
pinned next to the user row.

## File handling

ZAO can read PDF, Word (.docx), PowerPoint (.pptx), ZIP archives, CSV, and
plain text/code files attached via the "+" button - and separately, create
new PDF/Word/Excel/PowerPoint/CSV files on request via the tool-calling
path (`services/pdf`, `services/office`).

- **Images** - stored and shown in the chat bubble via
  `copyAttachmentLocally` (`chatStore.js`), but not analyzed - there is no
  vision model wired up.
- **CSV, plain text/code files** - extracted entirely on-device
  (`src/services/textExtraction.js`) via `expo-file-system` + `papaparse`.
- **ZIP archives** - unzipped entirely on-device (`jszip`, pure JS), capped
  at 30 entries / ~60,000 combined characters so a huge archive can't hang
  the app or blow out the model's context window.
- **PDF, Word (.docx), and PowerPoint (.pptx) reading** - two-tier,
  entirely on-device, no account or backend required:
  1. **Pure-JS** (`src/files/pdfExtractor.js`, `officeExtractors.js`) -
     tried first, always available, zero setup. Pattern/regex-based
     rather than a full parser, so it works well on simple text-based
     documents but not scanned/image PDFs or unusual encodings.
  2. **Termux fallback** (PDF/DOCX only, via `terminal/terminalTool.js`) -
     tried if tier 1 fails or returns suspiciously little text.
     `pdftotext` (from the `poppler` package) for PDF, a small
     `python-docx` one-liner for DOCX. Requires the relevant Termux
     package installed once (`pkg install poppler` /
     `pip install python-docx`); if it's not, ZAO returns the pure-JS
     result (or a clear install-command error) rather than hanging.
- **Generating PDF/Word/Excel/PowerPoint files** - via the local
  tool-calling path (Qwen2.5 Coder as router), not a separate UI: describe
  what you want, and `pdf_create`/`docx_create`/`xlsx_create`/`pptx_create`
  get called automatically. See `src/services/toolOrchestrator.js`'s tool
  schemas for exactly what each can produce.

## Message actions (long-press menu)

Long-pressing a message bubble opens a floating context menu
(`src/components/MessageActionMenu.js`): background dims/blurs, the bubble
pops slightly, a haptic fires, the menu fades/scales in.

- **User's own message**: Copy, Edit.
- **Assistant message**: Copy, Regenerate (re-runs the orchestrator against
  the prior user turn), Read Aloud (native Android TTS). Like/Dislike are
  wired as optional callback props on `MessageActionMenu` - each row only
  renders if its callback is actually passed in from `ChatScreen.js`.

**Edit** (user messages only) pulls the message's text back into the
composer and swaps Send for Save; the original message stays visible while
editing (no flicker from removing/re-adding it mid-type), and Save updates
that row's `content` in place via `chatStore.editMessage()` /
`db/database.js`'s `updateMessage()`, stamping `edited_at`. Editing does
NOT re-send to the model or touch later messages - it's a correction to the
historical record, not a new turn.

## Known gaps / not yet built

- **No vision or image generation** - attached images display but aren't
  analyzed; there's no way to generate or edit images. Would need a local
  vision-capable model, which isn't wired up.
- **No voice input** - the mic button, Voice Mode, and Whisper
  transcription have all been removed. Read Aloud (text-to-speech output)
  still works.
- **No cloud sync or backup** - Supabase has been removed entirely.
  `zao.db` on the device is the only copy of conversations/preferences;
  there is no way to move data to another device or recover it if the
  device is lost, short of manually copying the SQLite file yourself.
- **Markdown renderer** (`src/components/MarkdownText.js`) is a lightweight
  hand-rolled parser (bold/italic/inline code/code blocks/headers/lists) -
  no tables, no links - deliberately, to avoid adding
  `react-native-markdown-display` as more native/build surface area.
- **Video understanding** - `frameSampler.js` can extract frames from a
  video, but nothing consumes them yet; video isn't a recognized
  attachment type.
