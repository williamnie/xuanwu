import { credentialSourcePayload, recommendCodexLogin, sourceForForm } from './piCredentialSource.js';
import { assistantApi } from '../api/assistant.js';
import { message } from '../store/toastStore';
import { clearFirstDeliveryConnectionTest, recordFirstDeliveryConnectionTest } from '../utils/firstDeliveryConnection.js';
import { loadPiCodexOAuthStatus } from './piAgentOAuthActions.js';
import { refreshAfterSave } from './piAgentSettingsPersistence.js';
import { providerPayload, formFromState, codexLoginForm } from './piAgentSettingsForm.js';

export function loadPiSettings(setProviders, setProviderCatalog, setForm, setLoading, setPromptSummary, setModelDiscovery, setOauthStatus, onboarding, isCurrent) {
  setLoading(true);
  Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiProviderSettings(), assistantApi.getPiProviderCatalog(), assistantApi.getPiCodexOAuthStatus()])
    .then(([supervisor, providerSettings, providerCatalog, oauthStatus]) => {
      if (!isCurrent()) return;
      setOauthStatus(oauthStatus);
      const nextProviders = providerSettings?.providers || [];
      setProviders(nextProviders);
      setProviderCatalog({ presets: providerCatalog?.presets || [] });
      const savedForm = formFromState(supervisor, nextProviders);
      const nextForm = onboarding && recommendCodexLogin(supervisor, nextProviders, oauthStatus) ? codexLoginForm(savedForm) : savedForm;
      setForm(nextForm);
      setPromptSummary(null);
      if (nextForm === savedForm && sourceForForm(nextForm) !== 'codex_login') void discoverPiModels(nextForm, setModelDiscovery, isCurrent);
    })
    .catch((err) => message.error(err.message || '读取玄武助手设置失败'))
    .finally(() => setLoading(false));
}

export async function discoverPiModels(form, setModelDiscovery, isCurrent = () => true, explicit = false) {
  const providerId = form.modelProvider.trim();
  if (!providerId) return;
  const credentialSource = sourceForForm(form);
  setModelDiscovery({ busy: true, providerId, credentialSource, result: null });
  try {
    const result = await assistantApi.getPiProviderModels(providerId, { ...providerPayload(form), ...(explicit ? credentialSourcePayload(form) : {}) });
    if (!isCurrent()) return;
    setModelDiscovery((current) => current.providerId === providerId && current.credentialSource === credentialSource ? { busy: false, providerId, credentialSource, result } : current);
  } catch (err) {
    if (!isCurrent()) return;
    setModelDiscovery((current) => current.providerId === providerId && current.credentialSource === credentialSource ? {
      busy: false,
      providerId,
      credentialSource,
      result: { error: 'request_failed', message: err.message || '读取远端模型列表失败', models: [], ok: false, status: 'failed' }
    } : current);
  }
}

export async function testPiConnection(form, setConnectionTest, setModelDiscovery, isCurrent = () => true) {
  const providerId = form.modelProvider.trim();
  if (!providerId) return message.error('请先选择 provider');
  const credentialSource = sourceForForm(form);
  setConnectionTest({ busy: true, providerId, credentialSource, result: null });
  try {
    const result = await assistantApi.testPiProviderConnection(providerId, { ...providerPayload(form), ...credentialSourcePayload(form) });
    if (!isCurrent()) return null;
    recordFirstDeliveryConnectionTest(result);
    setConnectionTest({ busy: false, providerId, credentialSource, result });
    setModelDiscovery({ busy: false, providerId, credentialSource, result });
    if (result.ok) message.success(result.message || '模型连接成功');
    else message.error(result.message || '模型连接失败');
    return result;
  } catch (err) {
    if (!isCurrent()) return null;
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId, credentialSource, result: { error: 'request_failed', message: err.message || '模型连接失败', ok: false, status: 'failed' } });
    setModelDiscovery({ busy: false, providerId, credentialSource, result: { error: 'request_failed', message: err.message || '读取远端模型列表失败', models: [], ok: false, status: 'failed' } });
    message.error(err.message || '模型连接失败');
    return null;
  }
}

export async function deletePiProviderConnection({
  providerId,
  setConnectionTest,
  setDeletingProviderId,
  setForm,
  setModelDiscovery,
  setOauthBusy,
  setOauthStatus,
  setProviders
}) {
  if (!providerId) return false;
  setDeletingProviderId(providerId);
  try {
    await assistantApi.deletePiProviderSettings(providerId);
    clearFirstDeliveryConnectionTest();
    setConnectionTest({ busy: false, providerId: '', result: null });
    setModelDiscovery({ busy: false, providerId: '', result: null });
    const refreshes = [refreshAfterSave(setProviders, setForm)];
    if (providerId === 'openai-codex') refreshes.push(loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy));
    await Promise.all(refreshes);
    message.success('模型连接已删除');
    return true;
  } catch (err) {
    message.error(err.message || '删除模型连接失败');
    return false;
  } finally {
    setDeletingProviderId('');
  }
}

export function selectConfiguredProvider(providerId, form, providers, presets, setForm, setConnectionTest, setModelDiscovery, isCurrent) {
  const configured = providers.find((provider) => provider.id === providerId);
  const preset = presets.find((item) => item.id === providerId);
  const next = {
    ...form,
    api: configured?.api || preset?.api || form.api,
    apiKey: '',
    baseUrl: configured?.base_url || preset?.base_url || '',
    modelId: configured?.models?.[0] || preset?.recommended_model || form.modelId,
    modelProvider: providerId,
    userAgent: configured?.user_agent || '',
  };
  clearFirstDeliveryConnectionTest();
  setConnectionTest({ busy: false, providerId: '', result: null });
  setForm(next);
  if (sourceForForm(next) !== 'codex_login') void discoverPiModels(next, setModelDiscovery, isCurrent);
}
