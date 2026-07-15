/**
 * ZAO - Orchestrator
 *
 * This is the single entry point the UI calls to "send a message and get a
 * response." It hides which local model to use for a given message.
 *
 * Routing is fully automatic via FIXED_MODEL_ROUTE (src/config/localModels.js)
 * - there is no manual mode and no per-conversation model override. There is
 * also no fallback chain: the text model is a local llama.rn context with
 * no rate limit and no other provider to retry on, so a failure here is a
 * real failure (model not imported, out of memory, inference error) and is
 * surfaced to the person as such rather than silently retried elsewhere.
 *
 * IMAGE GENERATION, IMAGE EDITING, AND VISION/OCR have been removed
 * entirely along with the Gemini provider - there is no cloud exception
 * left in the app. An attached image is stored and displayed in chat (see
 * copyAttachmentLocally in chatStore.js) but is not sent to any model;
 * ZAO is fully local/text-only now.
 *
 * Contract: sendMessageOrchestrated() NEVER throws. It always resolves to a
 * result object. The UI only needs to handle one shape.
 */

import { logUsageEvent } from '../db/database';
import {
  classifyTask,
  getModelKeyForTask,
  LOCAL_MODELS,
} from '../config/localModels';
import * as llamaEngine from '../services/llama/llamaEngine';
import { runGithubTask } from '../services/toolOrchestrator';

// Server-based browserRouter/client.js is replaced by the on-device
// AgentSession (src/services/browserAgent/agentLoop.js) below - no backend
// server or FastAPI tunnel required anymore. The AgentSession itself is
// created and held at the App level (it needs a live component ref to the
// mounted BrowserAgentPiP/BrowserAgentView) and passed in per-call as
// `agentSession`, the same way onBrowserStep used to be passed in.

/**
 * @param {object} params
 * @param {Array<{role, content}>} params.history - full conversation so far, including the new user message
 * @param {string} [params.lastMessageText] - used for task classification
 * @param {boolean} [params.browserAccessEnabled] - gates the on-device browser agent. When
 *   false (default), browsing-classified messages fall straight through to normal
 *   chat routing - the person must explicitly turn on the composer bar's globe
 *   toggle to allow live web access.
 * @param {object} [params.agentSession] - the live AgentSession instance (src/services/browserAgent/agentLoop.js),
 *   created once at the App level and held for the lifetime of the browser-agent PiP
 *   so a session's browser state/history survives across multiple separate tasks in
 *   the same conversation.
 * @param {function} [params.onBrowserStep] - callback fired per completed browser-agent step
 * @param {string} [params.githubUsername] - hint passed to the tool orchestrator so the coder model
 *   doesn't have to ask "whose account?" on every request
 * @param {function} [params.onGithubStep] - callback fired per completed tool-orchestrator step
 *
 * @returns {Promise<{
 *   success: boolean,
 *   data: { content: string, family: string, provider: string, modelId: string, imageBase64?: string, imageMimeType?: string } | null,
 *   error: { type: string, message: string } | null,
 * }>}
 */
export async function sendMessageOrchestrated({
  history,
  lastMessageText = '',
  browserAccessEnabled = false,
  agentSession = null,
  onBrowserStep = null,
  githubUsername = null,
  onGithubStep = null,
  onModelLoadProgress = null,
}) {
  try {
    if (!Array.isArray(history) || history.length === 0) {
      return {
        success: false,
        data: null,
        error: { type: 'BAD_REQUEST', message: 'No conversation history provided' },
      };
    }

    const detectedTask = classifyTask(lastMessageText);

    // ========================================================================
    // TOOL ORCHESTRATOR (GitHub + Filesystem + PDF + Office) - checked
    // before the browser toggle and normal chat routing.
    // ========================================================================
    if (detectedTask === 'github') {
      const githubResult = await runGithubTask(lastMessageText, githubUsername, onGithubStep);

      if (githubResult.success) {
        return {
          success: true,
          data: {
            content: githubResult.answer,
            family: 'qwen25_coder_3b',
            provider: 'local',
            modelId: LOCAL_MODELS.qwen25_coder_3b.label,
            toolStepsCompleted: githubResult.stepsCompleted,
          },
          error: null,
        };
      }

      return {
        success: false,
        data: null,
        error: githubResult.error || { type: 'UNKNOWN', message: 'Tool task failed.' },
      };
    }

    // ========================================================================
    // ON-DEVICE BROWSER AGENT - checked before normal chat routing. Once the
    // person has explicitly turned on the composer bar's globe/browser-
    // access toggle, every message goes here - short-circuits the whole
    // normal chat-completion path.
    // ========================================================================
    if (browserAccessEnabled) {
      if (agentSession) {
        const agentResult = await agentSession.runTask(lastMessageText, {
          onStep: (stepInfo) => onBrowserStep?.(stepInfo),
        });

        if (agentResult.success) {
          logUsageEvent('browser_session', lastMessageText.slice(0, 80), { stepsUsed: agentResult.stepsUsed }).catch(() => {});
          return {
            success: true,
            data: {
              content: agentResult.answer,
              family: 'qwen25_coder_3b',
              provider: 'local',
              modelId: LOCAL_MODELS.qwen25_coder_3b.label,
              browserStepsUsed: agentResult.stepsUsed,
            },
            error: null,
          };
        }

        if (agentResult.needsHuman) {
          return {
            success: false,
            data: null,
            error: { type: 'NEEDS_HUMAN', message: agentResult.reason },
          };
        }

        return {
          success: false,
          data: null,
          error: {
            type: agentResult.error?.type || 'BROWSER_AGENT_ERROR',
            message: agentResult.error?.message || 'Browser agent task failed.',
          },
        };
      }
      // No session yet (PiP not mounted) - fall through to normal routing below.
    }

    // Note: 'imageGeneration' is still a classifyTask() category (kept for
    // any UI that inspects it), but there is no longer a provider behind
    // it - Gemini has been removed. An imageGeneration-classified message
    // now just falls through to normal chat completion below like any
    // other text message.

    // ========================================================================
    // NORMAL CHAT COMPLETION - fixed, single local model per task category,
    // no fallback (see config/localModels.js).
    // ========================================================================
    const modelKey = getModelKeyForTask(detectedTask);
    const model = LOCAL_MODELS[modelKey];

    const result = await llamaEngine.sendMessage(history, modelKey, { maxTokens: 1024, temperature: 0.7, onLoadProgress: onModelLoadProgress });

    if (result.success) {
      return {
        success: true,
        data: {
          content: result.data.content,
          family: modelKey,
          provider: 'local',
          modelId: model.label,
        },
        error: null,
      };
    }

    return {
      success: false,
      data: null,
      error: result.error || { type: 'UNKNOWN', message: 'Local model failed to respond.' },
    };
  } catch (err) {
    // Absolute last-resort catch. The UI should never see an uncaught exception
    // from this function, no matter what goes wrong internally.
    console.error('[Orchestrator] Unexpected error:', err);
    return {
      success: false,
      data: null,
      error: { type: 'UNKNOWN', message: 'Something went wrong. Please try again.' },
    };
  }
}
