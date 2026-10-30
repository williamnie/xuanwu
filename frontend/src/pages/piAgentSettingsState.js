import { credentialReady, sourceMatches } from './piCredentialSource.js';
import { assistantApi } from '../api/assistant.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from '../store/toastStore';
import { clearFirstDeliveryConnectionTest } from '../utils/firstDeliveryConnection.js';
import { watchPiOAuthStatus } from './piOAuthStatusPolling.js';
import { DEFAULT_PI_AGENT_FORM, connectionFormForApi, availableProviderID, defaultBaseURL, providerModelOptions, codexLoginForm } from './piAgentSettingsForm.js';
import { loadPiSettings, discoverPiModels, testPiConnection, deletePiProviderConnection, selectConfiguredProvider } from './piAgentConnectionActions.js';
import { loadPiCodexOAuthStatus, startPiOAuthLogin, copyOAuthUrl, logoutPiOAuth, openOAuthUrl, loadPiPromptSummary } from './piAgentOAuthActions.js';
import { savePiConnectionAndSupervisor, savePiSupervisorSettings } from './piAgentSettingsPersistence.js';
export { DEFAULT_PI_AGENT_FORM } from './piAgentSettingsForm.js';

const CONNECTION_FIELDS = new Set(['api', 'apiKey', 'baseUrl', 'modelProvider', 'userAgent', 'credentialSource']);

export function usePiAgentSettingsState({ onboarding = false } = {}) {
  const connectionAttemptRef = useRef(0);
  const [connectionTest, setConnectionTest] = useState({ busy: false, providerId: '', result: null });
  const [deletingProviderId, setDeletingProviderId] = useState('');
  const [modelDiscovery, setModelDiscovery] = useState({ busy: false, providerId: '', result: null });
  const [providers, setProviders] = useState([]);
  const [providerCatalog, setProviderCatalog] = useState({ presets: [] });
  const [form, setForm] = useState(DEFAULT_PI_AGENT_FORM);
  const [loading, setLoading] = useState(true);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState(null);
  const [promptSummary, setPromptSummary] = useState(null);
  const [promptSummaryLoading, setPromptSummaryLoading] = useState(false);
  const [personaConflictDraft, setPersonaConflictDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === form.modelProvider),
    [form.modelProvider, providers]
  );
  const selectedPreset = useMemo(
    () => providerCatalog.presets.find((preset) => preset.id === form.modelProvider),
    [form.modelProvider, providerCatalog.presets]
  );
  const modelOptions = useMemo(
    () => providerModelOptions(form, modelDiscovery),
    [form, modelDiscovery]
  );
  const modelSelectAvailable = modelDiscovery.providerId === form.modelProvider && sourceMatches(form, modelDiscovery) && modelDiscovery.result?.ok === true;

  const invalidateConnectionTest = useCallback(() => {
    connectionAttemptRef.current += 1;
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId: '', result: null });
  }, []);
  const loadSettings = useCallback(() => {
    invalidateConnectionTest();
    const attempt = connectionAttemptRef.current;
    loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary, setModelDiscovery, setOauthStatus, onboarding, () => connectionAttemptRef.current === attempt);
  }, [invalidateConnectionTest, onboarding]);
  const loadOAuthStatus = () => loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy);
  const loadPromptSummary = () => loadPiPromptSummary(setPromptSummary, setPromptSummaryLoading);
  const updateField = (key, value) => {
    if (key === 'instructions' || key.startsWith('persona')) setPromptSummary(null);
    if (key === 'modelId') invalidateConnectionTest();
    if (CONNECTION_FIELDS.has(key)) {
      invalidateConnectionTest();
      setModelDiscovery({ busy: false, providerId: '', result: null });
    }
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key.startsWith('persona') && key !== 'personaRevision' && key !== 'personaDirty' ? { personaDirty: true } : {})
    }));
  };
  const selectProviderPreset = (preset) => {
    invalidateConnectionTest();
    setModelDiscovery({ busy: false, providerId: '', result: null });
    const configured = providers.find((provider) => provider.id === preset.id);
    const next = {
      ...form,
      api: configured?.api || preset.api,
      apiKey: '',
      baseUrl: configured?.base_url || preset.base_url,
      modelId: form.modelProvider === preset.id
        ? form.modelId
        : configured?.models?.[0] || preset.recommended_model,
      modelProvider: preset.id,
      credentialSource: 'stored'
    };
    setForm(next);
  };
  const selectApiProtocol = (api) => {
    invalidateConnectionTest();
    setModelDiscovery({ busy: false, providerId: '', result: null });
    setForm(connectionFormForApi(api, form, providers, providerCatalog.presets));
  };
  const startNewApiConnection = () => {
    const api = form.api === 'openai-codex-responses' ? 'openai-responses' : form.api;
    invalidateConnectionTest();
    setModelDiscovery({ busy: false, providerId: '', result: null });
    setForm((current) => ({
      ...current,
      api,
      apiKey: '',
      baseUrl: defaultBaseURL(api),
      modelId: '',
      modelProvider: availableProviderID(api, providers),
      userAgent: ''
    }));
  };
  const selectApiMode = () => selectApiProtocol(form.api === 'openai-codex-responses' ? 'openai-responses' : form.api);
  const selectOAuthMode = () => {
    const preset = providerCatalog.presets.find((item) => item.auth === 'oauth');
    if (!preset) return message.error('当前版本没有可用的玄武助手 OAuth 登录');
    selectProviderPreset(preset);
  };
  const selectCodexLogin = () => {
    if (!oauthStatus?.codex_login?.available) return;
    invalidateConnectionTest();
    setModelDiscovery({ busy: false, providerId: '', result: null });
    setForm(current => codexLoginForm(current));
  };
  const discoverModels = () => {
    invalidateConnectionTest();
    const attempt = connectionAttemptRef.current;
    return discoverPiModels(form, setModelDiscovery, () => connectionAttemptRef.current === attempt, true);
  };
  const deleteProviderConnection = (providerId) => {
    invalidateConnectionTest();
    return deletePiProviderConnection({
      providerId,
      setConnectionTest,
      setDeletingProviderId,
      setForm,
      setModelDiscovery,
      setOauthBusy,
      setOauthStatus,
      setProviders
    });
  };
  const handleConnectionApply = () => {
    if (form.api === 'openai-codex-responses' && !credentialReady(form, oauthStatus)) return Promise.resolve(false);
    return savePiConnectionAndSupervisor({ form, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving });
  };
  const handleAgentSave = () => {
    if (form.api === 'openai-codex-responses' && !credentialReady(form, oauthStatus)) return Promise.resolve(false);
    return savePiSupervisorSettings({ form, providers, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving });
  };
  const restorePersonaConflictDraft = () => {
    if (!personaConflictDraft) return;
    setForm((current) => ({ ...current, ...personaConflictDraft, personaDirty: true }));
    setPersonaConflictDraft(null);
  };
  const dismissPersonaConflictDraft = () => setPersonaConflictDraft(null);
  const selectModelProvider = (providerId) => {
    invalidateConnectionTest();
    const attempt = connectionAttemptRef.current;
    return selectConfiguredProvider(providerId, form, providers, providerCatalog.presets, setForm, setConnectionTest, setModelDiscovery, () => connectionAttemptRef.current === attempt);
  };
  const testConnection = () => {
    const attempt = ++connectionAttemptRef.current;
    return testPiConnection(form, setConnectionTest, setModelDiscovery, () => connectionAttemptRef.current === attempt);
  };
  const startPiCodexOAuthLogin = () => {
    invalidateConnectionTest();
    return startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus);
  };
  const copyPiCodexOAuthUrl = () => copyOAuthUrl(oauthStatus?.auth_url);
  const openPiCodexOAuthUrl = () => openOAuthUrl(oauthStatus?.auth_url);
  const logoutPiCodexOAuth = () => {
    invalidateConnectionTest();
    return logoutPiOAuth(setOauthBusy, setOauthStatus);
  };

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const oauthLifecycle = oauthStatus?.status || oauthStatus?.pi_oauth?.status;
  const oauthStartedAt = oauthStatus?.started_at;
  useEffect(() => {
    if (oauthBusy || oauthLifecycle !== 'pending') return;
    return watchPiOAuthStatus({ readStatus: assistantApi.getPiCodexOAuthStatus, onStatus: setOauthStatus });
  }, [oauthBusy, oauthLifecycle, oauthStartedAt]);

  return { connectionTest, deletingProviderId, form, loading, modelDiscovery, modelOptions, modelSelectAvailable, oauthBusy, oauthStatus, personaConflictDraft, promptSummary, promptSummaryLoading, providerCatalog, providers, saving, selectedPreset, selectedProvider,
    copyPiCodexOAuthUrl, deleteProviderConnection, dismissPersonaConflictDraft, discoverModels, handleAgentSave, handleConnectionApply, loadOAuthStatus, loadPromptSummary, loadSettings, logoutPiCodexOAuth, openPiCodexOAuthUrl, restorePersonaConflictDraft, selectApiMode, selectApiProtocol, selectModelProvider, selectOAuthMode, selectCodexLogin, selectProviderPreset, startNewApiConnection, startPiCodexOAuthLogin, testConnection, updateField };
}
