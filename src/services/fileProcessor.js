/**
 * ZAO - File Processing Orchestrator
 *
 * Single entry point the UI calls for any attached file, regardless of
 * type. Routes to the right extractor (fileTypes.js decides which),
 * normalizes every extractor's result into one shape, and never throws -
 * matching the same contract as the AI orchestrator (utils/orchestrator.js).
 */

import { categorizeFile, FILE_CATEGORY, getCategoryLabel } from './fileTypes';
import { extractPlainText, extractCsv } from './textExtraction';
import { extractZipContents } from './zipHandler';
import { extractDocument } from './documentExtraction';

/**
 * @param {object} file - { uri, name, mimeType, size }
 * @param {string} [userMessageText] - unused for images now (vision removed); kept in the
 * signature so callers don't need to change how they invoke this.
 * @returns {Promise<{
 *   success: boolean,
 *   category: string,
 *   categoryLabel: string,
 *   isImage: boolean,
 *   text: string | null,
 *   truncated: boolean,
 *   error: string | null,
 * }>}
 */
export async function processAttachedFile(file, userMessageText = '') {
  const { uri, name, mimeType } = file;

  try {
    const category = categorizeFile(name, mimeType);
    const categoryLabel = getCategoryLabel(category);

    switch (category) {
      case FILE_CATEGORY.IMAGE:
        return processImage(uri, userMessageText);

      case FILE_CATEGORY.PDF: {
        const result = await extractDocument(uri, name, 'pdf');
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.DOCX: {
        const result = await extractDocument(uri, name, 'docx');
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.PPTX: {
        const result = await extractDocument(uri, name, 'pptx');
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.ZIP: {
        const result = await extractZipContents(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.summary : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CSV: {
        const result = await extractCsv(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CODE_OR_TEXT: {
        const result = await extractPlainText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      default:
        return {
          success: false,
          category: FILE_CATEGORY.UNKNOWN,
          categoryLabel: 'File',
          isImage: false,
          text: null,
          truncated: false,
          error: `ZAO doesn't know how to read "${name}" yet. Supported: PDF, Word (.docx), ZIP, CSV, and text/code files.`,
        };
    }
  } catch (err) {
    console.error('[FileProcessor] processAttachedFile failed:', err);
    return {
      success: false,
      category: FILE_CATEGORY.UNKNOWN,
      categoryLabel: 'File',
      isImage: false,
      text: null,
      truncated: false,
      error: 'Something went wrong processing this file. Please try again.',
    };
  }
}

/**
 * Image handling: vision/OCR (Florence-2, Qwen2.5-VL) was Hugging
 * Face-only and has been removed along with the rest of the HF/OpenRouter
 * cloud stack - there is no local vision model wired up yet, and no cloud
 * replacement either. Attached images now return a clear "not supported"
 * result rather than silently doing nothing or crashing - the person sees
 * exactly why nothing was analyzed instead of a confusing blank response.
 * The image itself still attaches and displays fine as a bubble (see
 * ChatScreen.js / chatStore.js's copyAttachmentLocally) - only the AI
 * analysis of it is unavailable.
 */
async function processImage(uri, userMessageText) {
  const categoryLabel = getCategoryLabel(FILE_CATEGORY.IMAGE);
  return {
    success: false,
    category: FILE_CATEGORY.IMAGE, categoryLabel, isImage: true,
    text: null, truncated: false,
    error: 'Image analysis isn\'t available right now - vision support was removed along with the Hugging Face models it depended on. Text, PDF, Word, ZIP, and CSV attachments still work.',
  };
}

/**
 * Formats an extraction result into the text block that gets prepended to
 * the user's message before sending to the AI orchestrator. Kept separate
 * from processAttachedFile so the chat store controls exactly how/where
 * this gets inserted into the conversation.
 */
export function formatFileContextBlock(fileName, result) {
  if (!result.success) {
    return null; // caller should show result.error to the user instead
  }
  const truncationNote = result.truncated ? ' (content truncated due to length)' : '';
  return `[Attached file: ${fileName} - ${result.categoryLabel}${truncationNote}]\n\n${result.text}`;
}
