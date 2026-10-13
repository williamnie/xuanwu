export function piConnectionStatus({ form, oauthStatus, selectedProvider, connectionTest }) {
  const oauthMode = form.api === 'openai-codex-responses';
  const test = connectionTest?.providerId === form.modelProvider ? connectionTest : null;
  const authorized = oauthMode
    ? Boolean(oauthStatus?.pi_oauth?.configured)
    : Boolean(test?.result?.ok || (!form.apiKey.trim() && selectedProvider?.api_key_configured));
  const model = !form.modelId.trim() || (oauthMode && !authorized) ? 'untested'
    : test?.busy ? 'testing'
      : !test?.result ? 'untested'
        : test.result.ok ? 'passed' : 'failed';
  return { authorized, model };
}
