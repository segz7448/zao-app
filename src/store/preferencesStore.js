/**
 * ZAO - Preferences Store (Zustand)
 */

import { create } from 'zustand';
import { getPreferences, updatePreferences, storeApiKey, getApiKey, deleteApiKey } from '../db/database';

const DEFAULT_PREFS = {
  tts_voice_identifier: null,
  tts_speech_rate: 1.0,
  tts_voice_preset: null,
  voice_mode_activation: 'hands_free',
  browser_access_enabled: false,
  memory_enabled: true,
};

export const usePreferencesStore = create((set, get) => ({
  preferences: DEFAULT_PREFS,
  isLoaded: false,
  apiKeyStatus: {
    browser_router: { configured: false, isUserProvided: false, isTrial: false },
    github: { configured: false, isUserProvided: false, isTrial: false, username: null },
  },

  async loadPreferences() {
    const result = await getPreferences();
    set({
      preferences: result.data || DEFAULT_PREFS,
      isLoaded: true,
    });

    // Also refresh API key status flags (not the key values themselves)
    const [routerToken, githubToken] = await Promise.all([
      getApiKey('browser_router'),
      getApiKey('github'),
    ]);
    set({
      apiKeyStatus: {
        browser_router: {
          // No trial key concept for this one - it's a personal self-hosted
          // backend, so "configured" is simply whether a token is stored.
          configured: !!routerToken?.data?.key_value,
          isUserProvided: !!routerToken?.data?.is_user_provided,
          isTrial: false,
        },
        github: {
          // No trial concept here either - GitHub write access has to be
          // the person's own account, there's no "default" GitHub token
          // that would make sense to bake into the app.
          configured: !!githubToken?.data?.key_value,
          isUserProvided: !!githubToken?.data?.is_user_provided,
          isTrial: false,
          username: result.data?.github_username || null,
        },
      },
    });
  },

  async setTtsVoice(voiceIdentifier) {
    const prev = get().preferences;
    // Picking a raw voice directly (e.g. from the Settings screen's full
    // voice list) clears any friendly preset selection, since the two are
    // now out of sync.
    set({ preferences: { ...prev, tts_voice_identifier: voiceIdentifier, tts_voice_preset: null } });
    const result = await updatePreferences({ tts_voice_identifier: voiceIdentifier, tts_voice_preset: null });
    if (!result.success) {
      set({ preferences: prev });
    }
  },

  /**
   * Selects one of Voice Mode's four friendly presets (Buttery/Airy/Mellow/
   * Glass). Unlike setTtsVoice, this persists the preset key AND its
   * resolved voice/rate together in one write, so both the Settings screen
   * and Voice Mode's sheet can tell which (if any) preset is active.
   */
  async setVoicePreset(presetKey, resolvedVoiceIdentifier, resolvedRate) {
    const prev = get().preferences;
    set({
      preferences: {
        ...prev,
        tts_voice_preset: presetKey,
        tts_voice_identifier: resolvedVoiceIdentifier,
        tts_speech_rate: resolvedRate,
      },
    });
    const result = await updatePreferences({
      tts_voice_preset: presetKey,
      tts_voice_identifier: resolvedVoiceIdentifier,
      tts_speech_rate: resolvedRate,
    });
    if (!result.success) {
      set({ preferences: prev });
    }
  },

  async setTtsSpeechRate(rate) {
    const prev = get().preferences;
    set({ preferences: { ...prev, tts_speech_rate: rate } });
    const result = await updatePreferences({ tts_speech_rate: rate });
    if (!result.success) {
      set({ preferences: prev });
    }
  },

  /**
   * Toggles the composer bar's globe/browser-access icon. This is the
   * explicit on/off gate for the Internet Router: sendMessageOrchestrated()
   * only auto-browses when this is true, regardless of whether a Browser
   * Router backend is configured. Persisted to SQLite (not just local
   * component state) so the toggle "remembers" what the person last set it
   * to across app restarts - it does NOT auto-revert to off on its own;
   * only an explicit tap turns it off.
   */
  async setBrowserAccessEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, browser_access_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ browser_access_enabled: enabled });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
  },

  /**
   * Toggles the long-term Memory feature (Settings > Memory - see
   * src/services/memory/memoryEngine.js). Turning this off stops both
   * context injection into new messages AND new-fact extraction, but does
   * NOT delete memories already stored - those stay until the person
   * explicitly clears them via the Memory settings screen.
   */
  async setMemoryEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, memory_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ memory_enabled: enabled });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
  },

  /**
   * Saves the Browser Router backend URL (Cloudflare Tunnel address of the
   * user's self-hosted browsing automation service). Not a secret - the
   * paired auth token is stored separately via setApiKey('browser_router', ...)
   * in Android Keystore-backed SecureStore, same as provider API keys.
   */
  async setBrowserRouterUrl(url) {
    const prev = get().preferences;
    set({ preferences: { ...prev, browser_router_url: url } });
    const result = await updatePreferences({ browser_router_url: url });
    if (!result.success) {
      set({ preferences: prev });
    }
  },

  async setApiKey(provider, keyValue) {
    const result = await storeApiKey(provider, keyValue, true);
    if (result.success) {
      set((state) => ({
        apiKeyStatus: {
          ...state.apiKeyStatus,
          [provider]: { ...state.apiKeyStatus[provider], configured: !!keyValue, isUserProvided: true, isTrial: false },
        },
      }));
    }
    return result;
  },

  // GitHub is the one provider where the app needs a piece of non-secret
  // metadata (the username) alongside the token - stored as a normal
  // preference rather than the secure api_keys table, since it isn't
  // sensitive and every GitHub API call needs it for owner/repo paths.
  /**
   * Grants device folder access via Android's SAF picker and refreshes the
   * store's own `preferences` afterward. requestAccess() (filesystemTool.js)
   * writes filesystem_saf_uri straight to SQLite via updatePreferences() -
   * it does NOT go through this store, so without the loadPreferences()
   * call below the in-memory `preferences` object here stays stale and any
   * screen reading `preferences.filesystem_saf_uri` (e.g. Settings'
   * "Granted"/"Not granted" pill) keeps showing the old value until the
   * app is restarted, even though the grant itself succeeded and persisted.
   */
  async grantFilesystemAccess() {
    const { requestAccess } = await import('../services/filesystem/filesystemTool');
    const result = await requestAccess();
    if (result.success) {
      await get().loadPreferences();
    }
    return result;
  },

  /**
   * Grants access to the folder containing the person's local GGUF model
   * files (e.g. an SD card path like /storage/XXXX-XXXX/Model/) via
   * Android's SAF picker - see src/services/llama/modelImportTool.js for
   * why this is a separate grant from grantFilesystemAccess above (a
   * completely different folder, and llama.rn needs the files actually
   * copied into app-private storage afterward, not just SAF-readable).
   * Refreshes the store's own `preferences` afterward for the same reason
   * grantFilesystemAccess does - requestModelFolderAccess() writes
   * model_folder_saf_uri straight to SQLite, bypassing this store.
   */
  async grantModelFolderAccess() {
    const { requestModelFolderAccess } = await import('../services/llama/modelImportTool');
    const result = await requestModelFolderAccess();
    if (result.success) {
      await get().loadPreferences();
    }
    return result;
  },

  async setGithubUsername(username) {
    const prev = get().preferences;
    set({ preferences: { ...prev, github_username: username } }); // optimistic
    const result = await updatePreferences({ github_username: username });
    if (result.success) {
      set((state) => ({
        apiKeyStatus: { ...state.apiKeyStatus, github: { ...state.apiKeyStatus.github, username } },
      }));
    }
    return result;
  },

  async removeApiKey(provider) {
    const result = await deleteApiKey(provider);
    if (result.success) {
      if (provider === 'github') {
        // Clear the stored username too - a token-less username sitting
        // around would be confusing ("configured: false" but a username
        // still showing) and serves no purpose without the token it
        // pairs with.
        await updatePreferences({ github_username: null });
      }
      // Falls back to trial-key status if one exists for this provider -
      // reuse loadPreferences rather than duplicating the trial-check logic.
      await get().loadPreferences();
    }
    return result;
  },
}));
