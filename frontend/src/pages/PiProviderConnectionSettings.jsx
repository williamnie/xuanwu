import { credentialReady, sourceMatches } from './piCredentialSource.js';
import { CheckCircle2, KeyRound, Loader2, PlugZap, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { ConnectionModeTabs, ApiConnectionFlow, OAuthConnectionFlow } from './PiProviderConnectionFlow.jsx';
import { ConnectionProgress } from './PiProviderConnectionProgress.jsx';
import { connectionDisplayName } from './piProviderConnectionLabels.js';

export function ProviderConnectionSettings({ state }) {
  const oauthMode = state.form.api === 'openai-codex-responses';
  return (
    <div className="provider-console">
      <div className="provider-console-main">
        <SavedConnectionPicker key={state.selectedProvider?.id || 'new-connection'} state={state} />
        <ConnectionModeTabs oauthMode={oauthMode} state={state} />
        {oauthMode ? <OAuthConnectionFlow state={state} /> : <ApiConnectionFlow state={state} />}
        <ModelSelection state={state} />
        <ConnectionResult state={state} />
        <ConnectionActions state={state} />
        <ProviderSummary providers={state.providers} />
      </div>
      <ConnectionProgress oauthMode={oauthMode} state={state} />
    </div>
  );
}

function SavedConnectionPicker({ state }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const provider = state.selectedProvider;
  const deleting = state.deletingProviderId === provider?.id;
  return (
    <div className="provider-connection-picker-block">
      <div className="provider-connection-toolbar">
        <span className="provider-console-label">CONNECTION</span>
        <div className="provider-connection-picker">
          <label>
            <span>已有连接</span>
            <select
              aria-label="已有连接"
              className="form-control"
              onChange={(event) => event.target.value ? state.selectModelProvider(event.target.value) : state.startNewApiConnection()}
              value={provider?.id || ''}
            >
              <option value="">＋ 新建连接</option>
              {state.providers.map((item) => <option key={item.id} value={item.id}>{connectionDisplayName(item)}</option>)}
            </select>
          </label>
          {provider ? (
            <button
              className="btn btn-secondary provider-delete-trigger"
              disabled={provider.in_use || deleting}
              onClick={() => setConfirmingDelete(true)}
              title={provider.in_use ? '当前默认连接不能删除，请先切换并保存其他连接' : '删除此模型连接'}
              type="button"
            >
              <Trash2 size={13} /> {provider.in_use ? '默认连接' : '删除连接'}
            </button>
          ) : null}
        </div>
      </div>
      {confirmingDelete && provider ? (
        <div aria-labelledby="provider-delete-confirm-title" className="provider-delete-confirm" role="alertdialog">
          <div>
            <strong id="provider-delete-confirm-title">删除 {connectionDisplayName(provider)}？</strong>
            <span>{provider.id === 'openai-codex' ? '将同时移除玄武助手的 OAuth 授权。' : '将同时撤销为此连接保存的 API Key。'}</span>
          </div>
          <div>
            <button className="btn btn-secondary" disabled={deleting} onClick={() => setConfirmingDelete(false)} type="button">取消</button>
            <button
              className="btn provider-delete-confirm-button"
              disabled={deleting}
              onClick={async () => {
                if (await state.deleteProviderConnection(provider.id)) setConfirmingDelete(false);
              }}
              type="button"
            >
              <Trash2 size={13} /> {deleting ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelSelection({ state }) {
  const discovery = state.modelDiscovery.providerId === state.form.modelProvider ? state.modelDiscovery : null;
  return (
    <section className="provider-model-section">
      <div className="provider-model-heading">
        <div><strong>获取并选择模型</strong><span>{modelDiscoveryHelp(discovery)}</span></div>
        <button className="btn btn-secondary" disabled={discovery?.busy} onClick={state.discoverModels} type="button">
          {discovery?.busy ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} 获取模型
        </button>
      </div>
      <RemoteModelField key={state.form.modelProvider} state={state} />
    </section>
  );
}

function modelDiscoveryHelp(discovery) {
  if (discovery?.busy) return '正在读取远端模型列表…';
  if (discovery?.result?.ok) return `已读取 ${discovery.result.models?.length || 0} 个模型，选择一个作为默认模型。`;
  if (discovery?.result && !discovery.result.ok) return discovery.result.message || '远端模型列表不可用，可手动填写模型 ID。';
  return '先验证凭据，再从远端读取模型列表。';
}

function RemoteModelField({ state }) {
  const [manual, setManual] = useState(false);
  const discovery = state.modelDiscovery.providerId === state.form.modelProvider ? state.modelDiscovery : null;
  const failed = Boolean(discovery?.result && !discovery.result.ok);
  const manualMode = manual || failed;

  return (
    <div className="provider-model-row">
      {manualMode ? (
        <input aria-label="模型 ID" className="form-control" onChange={(event) => state.updateField('modelId', event.target.value)} placeholder="例如 gpt-5.4 / claude-sonnet-4-6" value={state.form.modelId} />
      ) : (
        <select aria-label="模型" className="form-control" disabled={!state.modelSelectAvailable || discovery?.busy} onChange={(event) => state.updateField('modelId', event.target.value)} value={state.form.modelId}>
          {state.modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      )}
      <button className="btn btn-secondary" disabled={manualMode && failed} onClick={() => setManual((current) => !current)} type="button">
        {manualMode ? '使用模型列表' : '手动输入模型 ID'}
      </button>
    </div>
  );
}

function ConnectionActions({ state }) {
  const busy = state.connectionTest.busy && state.connectionTest.providerId === state.form.modelProvider;
  return (
    <footer className="provider-connection-actions">
      <p>保存后，玄武助手会使用这里选定的连接和默认模型。</p>
      <div>
        <button className="btn btn-secondary" disabled={busy} onClick={state.testConnection} type="button">
          {busy ? <Loader2 size={14} className="spin-animation" /> : <PlugZap size={14} />} 测试连接
        </button>
        <button className="btn btn-primary" disabled={state.saving || (state.form.api === 'openai-codex-responses' && !credentialReady(state.form, state.oauthStatus))} onClick={state.handleConnectionApply} type="button">
          {state.saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存并设为默认
        </button>
      </div>
    </footer>
  );
}

function ConnectionResult({ state }) {
  const test = state.connectionTest;
  if (test.providerId !== state.form.modelProvider || !sourceMatches(state.form, test) || !test.result) return null;
  return (
    <div className={`provider-test-result ${test.result.ok ? 'success' : 'error'}`} role="status">
      {test.result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
      <span>{test.result.message || (test.result.ok ? '连接成功' : '连接失败')}</span>
    </div>
  );
}

function ProviderSummary({ providers }) {
  if (providers.length === 0) return null;
  return (
    <details className="provider-saved-connections">
      <summary>已保存连接 <span>{providers.length}</span></summary>
      <div>
        {providers.map((provider) => (
          <span key={provider.id}><KeyRound size={13} color={provider.api_key_configured ? 'var(--success)' : 'var(--text-muted)'} />{connectionDisplayName(provider)}</span>
        ))}
      </div>
    </details>
  );
}
