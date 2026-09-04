import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, RefreshCw, Save, XCircle } from 'lucide-react';
import { useState } from 'react';
import { usePiAgentSettingsState } from '../piAgentSettingsState.js';

const OPENAI_PROTOCOLS = new Set(['openai-responses', 'openai-completions']);

export default function OnboardingSupervisorConnection({ onComplete }) {
  const state = usePiAgentSettingsState();
  const [keyVisible, setKeyVisible] = useState(false);
  const oauthMode = state.form.api === 'openai-codex-responses';
  const openAICompatible = OPENAI_PROTOCOLS.has(state.form.api);
  const apiSupported = openAICompatible || state.form.api === 'anthropic';
  const activeTest = state.connectionTest.providerId === state.form.modelProvider
    ? state.connectionTest
    : null;
  const tested = activeTest?.result?.ok === true;
  const oauthConfigured = Boolean(state.oauthStatus?.pi_oauth?.configured);
  const credentialReady = oauthMode
    ? oauthConfigured
    : Boolean(apiSupported && state.form.baseUrl.trim() && (state.form.apiKey.trim() || state.selectedProvider?.api_key_configured));

  if (state.loading) {
    return <div className="first-delivery-inline-loading"><Loader2 className="spin-animation" size={14} /> 正在读取 Supervisor 连接…</div>;
  }

  const saveAndContinue = async () => {
    if (await state.handleConnectionApply()) await onComplete();
  };

  return (
    <div className="first-delivery-supervisor">
      <nav aria-label="Supervisor 连接方式" className="first-delivery-mode-tabs">
        <button aria-pressed={!oauthMode} className={!oauthMode ? 'active' : ''} onClick={state.selectApiMode} type="button"><span>API</span> API 连接</button>
        <button aria-pressed={oauthMode} className={oauthMode ? 'active' : ''} onClick={state.selectOAuthMode} type="button"><span>OA</span> Codex / ChatGPT OAuth</button>
      </nav>

      {oauthMode ? (
        <OAuthFlow configured={oauthConfigured} state={state} />
      ) : (
        <ApiFlow apiSupported={apiSupported} keyVisible={keyVisible} openAICompatible={openAICompatible} setKeyVisible={setKeyVisible} state={state} />
      )}

      <div className="first-delivery-model-row">
        <label>
          <span>MODEL</span>
          {state.modelSelectAvailable ? (
            <select className="form-control" onChange={event => state.updateField('modelId', event.target.value)} value={state.form.modelId}>
              {state.modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          ) : (
            <input className="form-control" onChange={event => state.updateField('modelId', event.target.value)} placeholder="模型 ID" value={state.form.modelId} />
          )}
        </label>
        <span>测试连接后可从远端模型目录选择，也可直接填写模型 ID。</span>
      </div>

      {activeTest?.result ? <ConnectionResult result={activeTest.result} /> : null}

      <footer className="first-delivery-connection-actions">
        <p>OAuth 使用独立 PI runtime 凭据；不会读取或回显 Codex CLI token。</p>
        <div>
          <button className="btn btn-secondary" disabled={!credentialReady || activeTest?.busy} onClick={state.testConnection} type="button">
            {activeTest?.busy ? <Loader2 className="spin-animation" size={14} /> : <RefreshCw size={14} />} 测试连接
          </button>
          <button className="btn btn-primary" disabled={!tested || state.saving} onClick={saveAndContinue} type="button">
            {state.saving ? <Loader2 className="spin-animation" size={14} /> : <Save size={14} />} 保存并继续
          </button>
        </div>
      </footer>
    </div>
  );
}

function ApiFlow({ apiSupported, keyVisible, openAICompatible, setKeyVisible, state }) {
  const configured = Boolean(state.selectedProvider?.api_key_configured);
  const selectOpenAI = () => state.selectApiProtocol(openAICompatible ? state.form.api : 'openai-responses');
  return (
    <section className="first-delivery-connection-flow">
      <div aria-label="API 兼容协议" className="first-delivery-provider-tabs">
        <button aria-pressed={openAICompatible} className={openAICompatible ? 'active' : ''} onClick={selectOpenAI} type="button">OPENAI-COMPATIBLE API</button>
        <button aria-pressed={state.form.api === 'anthropic'} className={state.form.api === 'anthropic' ? 'active' : ''} onClick={() => state.selectApiProtocol('anthropic')} type="button">ANTHROPIC-COMPATIBLE API</button>
      </div>
      {!apiSupported ? (
        <div className="first-delivery-unsupported-protocol" role="status">当前默认连接使用高级协议。请选择 OpenAI-compatible 或 Anthropic-compatible API 继续首次配置。</div>
      ) : <><div className="first-delivery-credential-grid">
        {openAICompatible ? (
          <label>
            <span>API FORMAT</span>
            <select className="form-control" onChange={event => state.selectApiProtocol(event.target.value)} value={state.form.api}>
              <option value="openai-responses">Responses API</option>
              <option value="openai-completions">Chat Completions</option>
            </select>
          </label>
        ) : null}
        <label>
          <span>BASE URL</span>
          <input className="form-control" onChange={event => state.updateField('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" value={state.form.baseUrl} />
        </label>
        <label className="first-delivery-api-key">
          <span>API KEY · {configured ? '已配置' : '只写入，不回显'}</span>
          <div>
            <input
              autoComplete="new-password"
              className="form-control"
              onChange={event => state.updateField('apiKey', event.target.value)}
              placeholder={configured ? '留空保留已保存 Key' : '粘贴 API Key'}
              type={keyVisible ? 'text' : 'password'}
              value={state.form.apiKey}
            />
            <button onClick={() => setKeyVisible(current => !current)} type="button">{keyVisible ? '隐藏' : '显示'}</button>
          </div>
        </label>
      </div>
      <p className="first-delivery-flow-note">GLM、DeepSeek 等兼容服务填写自己的 Base URL；其他原生协议留在高级设置。</p></>}
    </section>
  );
}

function OAuthFlow({ configured, state }) {
  const status = state.oauthStatus;
  const lifecycle = status?.status || status?.pi_oauth?.status || 'idle';
  const label = configured ? '已授权' : lifecycle === 'pending' ? '等待授权' : lifecycle === 'error' ? '授权失败' : '未授权';
  return (
    <section className="first-delivery-connection-flow first-delivery-oauth-flow">
      <div className="first-delivery-oauth-heading">
        <div><strong>使用现有 ChatGPT 账号登录</strong><p>玄武会生成一次性地址，并将凭据写入独立的 PI runtime authority。</p></div>
        <span className={configured ? 'ready' : lifecycle}>{label}</span>
      </div>
      {status?.message ? <p className={lifecycle === 'error' ? 'oauth-error' : ''}>{status.message}</p> : null}
      {status?.auth_url ? <code>{status.auth_url}</code> : null}
      <div className="first-delivery-oauth-actions">
        <button className="btn btn-primary" disabled={state.oauthBusy} onClick={state.startPiCodexOAuthLogin} type="button">
          {state.oauthBusy ? <Loader2 className="spin-animation" size={14} /> : <KeyRound size={14} />} {configured ? '重新授权' : '开始授权'}
        </button>
        <button className="btn btn-secondary" disabled={!status?.auth_url} onClick={state.copyPiCodexOAuthUrl} type="button"><Copy size={14} /> 复制地址</button>
        <button className="btn btn-secondary" disabled={!status?.auth_url} onClick={state.openPiCodexOAuthUrl} type="button"><ExternalLink size={14} /> 打开授权页</button>
        <button aria-label="刷新 OAuth 状态" className="btn btn-secondary" disabled={state.oauthBusy} onClick={state.loadOAuthStatus} title="刷新 OAuth 状态" type="button"><RefreshCw size={14} /></button>
      </div>
    </section>
  );
}

function ConnectionResult({ result }) {
  return (
    <div className={`first-delivery-connection-result ${result.ok ? 'success' : 'error'}`} role="status">
      {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
      <span>{result.message || (result.ok ? '连接成功' : '连接失败')}</span>
    </div>
  );
}
