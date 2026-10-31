
export function connectionTarget(value) {
  if (!value) return '待填写';
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

export function connectionApiLabel(api) {
  if (api === 'openai-codex-responses') return 'ChatGPT OAuth';
  if (api === 'openai-responses') return 'OpenAI Responses';
  if (api === 'openai-completions') return 'OpenAI Chat Completions';
  if (api === 'anthropic') return 'Anthropic Messages';
  if (api === 'google') return 'Google Gemini';
  return api || '模型 API';
}

export function connectionDisplayName(provider) {
  const model = provider.models?.[0];
  return `${connectionApiLabel(provider.api)}${model ? ` · ${model}` : ''}`;
}
