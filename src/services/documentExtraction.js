/**
 * ZAO - Document Extraction (local: pure-JS first, Termux fallback)
 *
 * Supabase (and its 'extract-document' Edge Function) has been removed
 * entirely - ZAO has no backend at all now. PDF/DOCX/PPTX text extraction
 * runs in two tiers, both fully on-device:
 *
 *   1. PURE-JS (src/files/pdfExtractor.js, officeExtractors.js) - tried
 *      first, always available, zero setup. Regex/pattern-based rather
 *      than a full parser, so it handles simple text-based documents well
 *      but not scanned/image PDFs, unusual encodings, or heavy tables -
 *      see those files' own docstrings for exactly what they can and
 *      can't do.
 *   2. TERMUX (pdftotext / python-docx via the Terminal tool,
 *      src/services/terminal/terminalTool.js) - tried only if step 1
 *      fails or returns suspiciously little text, since Termux is a real,
 *      battle-tested toolchain and can succeed on documents the pure-JS
 *      path can't (complex layouts, certain encodings). Requires Termux
 *      to be set up and the relevant package installed
 *      (`pkg install poppler` / `pip install python-docx`) - if it's not,
 *      the pure-JS result (or its error) is what gets returned, since
 *      there's nothing better to fall back to.
 *
 * This mirrors "there's an ongoing project or Termux session running
 * anyway" - the pure-JS path costs nothing and runs first for instant
 * results; Termux is the belt-and-suspenders path for when it's already
 * up and can do a more thorough job.
 */

import { extractPdfText } from '../files/pdfExtractor';
import { extractDocxText, extractPptxText } from '../files/officeExtractors';
import { runCommand } from './terminal/terminalTool';
import * as FileSystem from 'expo-file-system/legacy';

const MAX_CHARS = 50000; // same cap the old server-side extractor used, kept for consistency
const TERMUX_HOME = '/data/data/com.termux/files/home';
const EXTRACT_DIR = `${TERMUX_HOME}/.zao-terminal/extract`;

// Below this length, a pure-JS extraction "succeeded" technically but
// probably missed most of the document (scanned PDF, unusual encoding,
// etc.) - worth trying Termux's more capable tools rather than accepting
// a near-empty result as final.
const SUSPICIOUSLY_SHORT_CHARS = 200;

function extractRunId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Copies a local attachment (file:// URI from expo-document-picker) into
 * Termux's home directory as base64-over-shell, since RUN_COMMAND has no
 * concept of "attach this app-private file" - only shell commands Termux
 * itself executes. Small-to-medium documents only (this base64-encodes
 * the whole file into a single shell command string); very large PDFs
 * could hit Android's Intent extras size limit, in which case the error
 * from runCommand will make that failure clear rather than hanging.
 */
async function copyIntoTermux(localUri, extension) {
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const id = extractRunId();
  const remotePath = `${EXTRACT_DIR}/${id}.${extension}`;

  const result = await runCommand(
    `mkdir -p "${EXTRACT_DIR}" && echo '${base64}' | base64 -d > "${remotePath}"`,
    { timeoutMs: 30000 }
  );

  if (!result.success) {
    return { success: false, remotePath: null, error: result.error?.message || 'Could not copy the file into Termux.' };
  }
  return { success: true, remotePath, error: null };
}

function cleanupInTermux(remotePath) {
  // Best-effort, fire-and-forget.
  runCommand(`rm -f "${remotePath}"`, { timeoutMs: 10000 }).catch(() => {});
}

/**
 * Runs the Termux-based extractor for PDF/DOCX. Returns the same
 * {success, text, error} shape the pure-JS extractors use, so callers
 * don't need to care which tier actually produced the result.
 */
async function extractViaTermux(localUri, fileType) {
  let remotePath = null;
  try {
    const copyResult = await copyIntoTermux(localUri, fileType);
    if (!copyResult.success) {
      return { success: false, text: '', error: copyResult.error };
    }
    remotePath = copyResult.remotePath;

    const command = fileType === 'pdf'
      ? `pdftotext -layout "${remotePath}" -`
      : `python3 -c "import docx,sys; d=docx.Document(sys.argv[1]); print('\\n'.join(p.text for p in d.paragraphs))" "${remotePath}"`;

    const result = await runCommand(command, { timeoutMs: 60000 });

    if (!result.success) {
      const missingTool = fileType === 'pdf'
        ? /pdftotext.*not found|command not found/i.test(result.error?.message || '')
        : /No module named .docx.|python3.*not found|command not found/i.test(result.error?.message || '');

      if (missingTool) {
        const installCmd = fileType === 'pdf' ? 'pkg install poppler' : 'pip install python-docx';
        return {
          success: false,
          text: '',
          error: `Termux fallback needs a one-time package install. In Termux, run:\n\n${installCmd}`,
        };
      }
      return { success: false, text: '', error: result.error?.message || 'Termux extraction failed.' };
    }

    return { success: true, text: result.data?.stdout || '', error: null };
  } catch (err) {
    return { success: false, text: '', error: err?.message || 'Termux extraction failed.' };
  } finally {
    if (remotePath) cleanupInTermux(remotePath);
  }
}

/**
 * @param {string} localUri - file:// URI of the PDF, DOCX, or PPTX
 * @param {string} fileName
 * @param {'pdf'|'docx'|'pptx'} fileType
 * @returns {Promise<{success: boolean, text: string, truncated: boolean, error: string|null}>}
 */
export async function extractDocument(localUri, fileName, fileType) {
  try {
    // Tier 1: pure-JS, always tried first - free, instant, no setup.
    let jsResult;
    if (fileType === 'pdf') {
      jsResult = await extractPdfText(localUri);
    } else if (fileType === 'docx') {
      jsResult = await extractDocxText(localUri);
    } else {
      jsResult = await extractPptxText(localUri);
    }

    const jsGoodEnough = jsResult.success && jsResult.text.trim().length >= SUSPICIOUSLY_SHORT_CHARS;
    if (jsGoodEnough) {
      const truncated = jsResult.text.length > MAX_CHARS;
      return {
        success: true,
        text: truncated ? jsResult.text.slice(0, MAX_CHARS) : jsResult.text,
        truncated,
        error: null,
      };
    }

    // Tier 2: pptx has no Termux fallback wired up (no simple one-liner
    // equivalent to pdftotext/python-docx here) - the pure-JS result
    // (or its error) is final for pptx either way.
    if (fileType === 'pptx') {
      if (jsResult.success) {
        const truncated = jsResult.text.length > MAX_CHARS;
        return { success: true, text: truncated ? jsResult.text.slice(0, MAX_CHARS) : jsResult.text, truncated, error: null };
      }
      return { success: false, text: '', truncated: false, error: jsResult.error };
    }

    // Tier 2: pure-JS failed or returned suspiciously little - try Termux,
    // which can succeed on documents the regex-based path can't.
    const termuxResult = await extractViaTermux(localUri, fileType);
    if (termuxResult.success && termuxResult.text.trim().length > 0) {
      const truncated = termuxResult.text.length > MAX_CHARS;
      return {
        success: true,
        text: truncated ? termuxResult.text.slice(0, MAX_CHARS) : termuxResult.text,
        truncated,
        error: null,
      };
    }

    // Both tiers failed (or Termux isn't set up) - prefer the pure-JS
    // error if it had one; otherwise surface Termux's.
    return {
      success: false,
      text: '',
      truncated: false,
      error: jsResult.error || termuxResult.error || `Could not extract text from this ${fileType.toUpperCase()} file.`,
    };
  } catch (err) {
    console.error('[DocumentExtraction] extractDocument failed:', err);
    return { success: false, text: '', truncated: false, error: 'Something went wrong reading this file. Please try again.' };
  }
}

