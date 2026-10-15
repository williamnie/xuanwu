import { credentialReady, sourceMatches } from './piCredentialSource.js';
export function piConnectionStatus({ form, oauthStatus, selectedProvider, connectionTest }) {
  const oauthMode = form.api === 'openai-codex-responses';
  const test = connectionTest?.providerId === form.modelProvider && sourceMatches(form, connectionTest) ? connectionTest : null;
  const authorized = oauthMode
    ? credentialReady(form, oauthStatus)
    : Boolean(test?.result?.ok || (!form.apiKey.trim() && selectedProvider?.api_key_configured));
  const model = !form.modelId.trim() || (oauthMode && !authorized) ? 'untested'
    : test?.busy ? 'testing'
      : !test?.result ? 'untested'
        : test.result.ok ? 'passed' : 'failed';
  return { authorized, model };
}
