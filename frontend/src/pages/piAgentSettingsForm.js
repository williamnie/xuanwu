import { sourceForForm, sourceMatches } from './piCredentialSource.js';
import { PRODUCT_TERMS } from '../brand';

export const DEFAULT_PI_AGENT_FORM = {
  agentName: PRODUCT_TERMS.supervisor,
  api: 'openai-responses',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  credentialSource: 'stored',
  enabled: true,
  instructions: '先回答用户真正关心的问题，再补必要理由；说人话，避免不必要的内部术语和流程播报。',
  modelId: 'gpt-5.4',
  modelProvider: 'openai',
  personaCommunicationStyle: '',
  personaDirty: false,
  personaEnabled: false,
  personaLanguageMode: 'system',
  personaPersonality: '',
  personaRevision: 0,
  personaVerbosity: 'adaptive',
  thinkingLevel: 'medium',
  userAgent: ''
};

export function connectionFormForApi(api, form, providers, presets) {
  const currentSaved = providers.some((provider) => provider.id === form.modelProvider);
  const currentUnsaved = form.api !== 'openai-codex-responses' && !currentSaved;
  const providerID = currentUnsaved ? availableProviderID(api, providers) : providerIDForApi(api);
  const configured = currentUnsaved
    ? undefined
    : providers.find((provider) => provider.id === providerID)
      || providers.find((provider) => provider.api === api && provider.id !== 'openai-codex');
  const preset = presets.find((item) => item.auth !== 'oauth' && item.api === api)
    || presets.find((item) => item.id === providerID);
  const nextProviderID = currentUnsaved ? providerID : configured?.id || preset?.id || providerID;
  const sameConnection = form.modelProvider === nextProviderID;
  return {
    ...form,
    api,
    apiKey: '',
    baseUrl: sameConnection
      ? form.baseUrl
      : configured?.base_url || preset?.base_url || defaultBaseURL(api),
    modelId: sameConnection
      ? form.modelId
      : configured?.models?.[0] || preset?.recommended_model || '',
    modelProvider: nextProviderID,
    userAgent: configured?.user_agent || ''
  };
}

export function availableProviderID(api, providers) {
  const base = providerIDForApi(api);
  const used = new Set(providers.map((provider) => provider.id));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function providerIDForApi(api) {
  if (api === 'anthropic') return 'anthropic';
  if (api === 'google') return 'google';
  return 'openai';
}

export function defaultBaseURL(api) {
  if (api === 'anthropic') return 'https://api.anthropic.com/v1';
  if (api === 'google') return 'https://generativelanguage.googleapis.com/v1beta';
  return 'https://api.openai.com/v1';
}

export function personaDraft(form) {
  return {
    personaCommunicationStyle: form.personaCommunicationStyle,
    personaEnabled: form.personaEnabled,
    personaLanguageMode: form.personaLanguageMode,
    personaPersonality: form.personaPersonality,
    personaVerbosity: form.personaVerbosity
  };
}

export function providerPayload(form) {
  return {
    api: form.api.trim(),
    api_key: form.apiKey.trim(),
    base_url: form.baseUrl.trim(),
    models: form.modelId.trim(),
    user_agent: form.userAgent.trim()
  };
}

export function supervisorPayload(form) {
  return {
    credential_source: sourceForForm(form),
    name: form.agentName.trim() || DEFAULT_PI_AGENT_FORM.agentName,
    model_provider: form.modelProvider.trim(),
    model_id: form.modelId.trim(),
    thinking_level: form.thinkingLevel,
    instructions: form.instructions,
    enabled: form.enabled,
    ...(form.personaDirty ? { persona: {
      expected_revision: form.personaRevision,
      enabled: form.personaEnabled,
      personality: form.personaPersonality,
      communication_style: form.personaCommunicationStyle,
      verbosity: form.personaVerbosity,
      language_mode: form.personaLanguageMode
    } } : {})
  };
}

export function formFromState(supervisor, providers) {
  if (!supervisor) return DEFAULT_PI_AGENT_FORM;
  const provider = providers.find((item) => item.id === supervisor.model_provider);
  return {
    ...DEFAULT_PI_AGENT_FORM,
    credentialSource: supervisor.credential_source || 'stored',
    agentName: normalizedSupervisorName(supervisor.name),
    api: provider?.api || (supervisor.model_provider === 'openai-codex' ? 'openai-codex-responses' : DEFAULT_PI_AGENT_FORM.api),
    apiKey: '',
    baseUrl: provider?.base_url || DEFAULT_PI_AGENT_FORM.baseUrl,
    enabled: supervisor.enabled === 1,
    instructions: normalizedInstructions(supervisor.instructions),
    modelId: supervisor.model_id || provider?.models?.[0] || DEFAULT_PI_AGENT_FORM.modelId,
    modelProvider: supervisor.model_provider || DEFAULT_PI_AGENT_FORM.modelProvider,
    personaCommunicationStyle: supervisor.persona?.communication_style || '',
    personaDirty: false,
    personaEnabled: supervisor.persona?.enabled === 1,
    personaLanguageMode: supervisor.persona?.language_mode || 'system',
    personaPersonality: supervisor.persona?.personality || '',
    personaRevision: Number.isInteger(supervisor.persona?.revision) ? supervisor.persona.revision : 0,
    personaVerbosity: supervisor.persona?.verbosity || 'adaptive',
    thinkingLevel: supervisor.thinking_level || DEFAULT_PI_AGENT_FORM.thinkingLevel,
    userAgent: provider?.user_agent || ''
  };
}

export function providerModelOptions(form, modelDiscovery) {
  const discovered = modelDiscovery.providerId === form.modelProvider && sourceMatches(form, modelDiscovery) && modelDiscovery.result?.ok
    ? modelDiscovery.result.models || []
    : [];
  return [...new Set([form.modelId, ...discovered].filter(Boolean))];
}

function normalizedInstructions(instructions) {
  const value = String(instructions || '').trim();
  if (!value) return DEFAULT_PI_AGENT_FORM.instructions;
  return instructions;
}

function normalizedSupervisorName(name) {
  const value = String(name || '').trim();
  if (!value) return DEFAULT_PI_AGENT_FORM.agentName;
  return name;
}

export function codexLoginForm(form) {
  return { ...form, api: 'openai-codex-responses', apiKey: '', baseUrl: '',
    credentialSource: 'codex_login', modelProvider: 'openai-codex' };
}
