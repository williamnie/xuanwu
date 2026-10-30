import { codexLoginMessage, sourceForForm } from './piCredentialSource.js';
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Field, TextField } from './PiSettingsFields.jsx';
import { CodexOAuthPanel, CodexLoginReuse } from './PiCodexOAuthPanel.jsx';

export function ConnectionModeTabs({ oauthMode, state }) {
  const { language, t } = useI18n();
  const english = language === 'en-US';
  const reuse = oauthMode && sourceForForm(state.form) === 'codex_login';
  return (
    <fieldset className="settings-notification-modes provider-mode-tabs">
      <legend>{english ? 'Connection method' : '连接方式'}</legend>
      <div className="settings-notification-mode">
        <label>
          <input checked={!oauthMode} name="assistant-connection-mode" onChange={state.selectApiMode} type="radio" />
          <span><strong>{english ? 'API connection' : 'API 连接'}</strong><small>{english ? 'Enter the API URL and key.' : '填写 API 地址和 Key。'}</small></span>
        </label>
      </div>
      <div className="settings-notification-mode">
        <label>
          <input checked={oauthMode && !reuse} name="assistant-connection-mode" onChange={state.selectOAuthMode} type="radio" />
          <span><strong>{t('credential.storedLogin')}</strong><small>{t('credential.storedHint')}</small></span>
        </label>
      </div>
      <div className="settings-notification-mode">
        <label>
          <input checked={reuse} disabled={!state.oauthStatus?.codex_login?.available && !reuse} name="assistant-connection-mode" onChange={state.selectCodexLogin} type="radio" />
          <span><strong>{t('credential.reuse')}</strong><small>{t('credential.reuseHint')}</small><small>{t(codexLoginMessage(state.oauthStatus?.codex_login))}</small></span>
        </label>
      </div>
    </fieldset>
  );
}

export function ApiConnectionFlow({ state }) {
  const configured = state.selectedProvider?.api_key_configured;
  return (
    <section className="provider-flow-section">
      <FlowHeading badge="推荐从这里开始" description="不要求安装 Codex 或 Claude Code，只要有兼容的 API 地址和 Key 即可。" title="连接到一个模型 API" />
      <div className="provider-credential-grid">
        <ApiTypeField state={state} />
        <TextField form={state.form} hint="Base URL / API Path" label="API 地址" name="baseUrl" placeholder="https://api.openai.com/v1" updateField={state.updateField} />
        <ApiKeyField configured={configured} state={state} />
      </div>
    </section>
  );
}

function ApiKeyField({ configured, state }) {
  const [visible, setVisible] = useState(false);
  return (
    <Field className="provider-api-key-field" hint="只写入，不回显已保存值" label={`API Key${configured ? ' · 已配置' : ''}`}>
      <div className="provider-key-control">
        <input
          autoComplete="new-password"
          className="form-control"
          onChange={(event) => state.updateField('apiKey', event.target.value)}
          placeholder={configured ? '••••••••  留空保留，输入新 Key 可覆盖' : '粘贴 API Key'}
          type={visible ? 'text' : 'password'}
          value={state.form.apiKey}
        />
        <button onClick={() => setVisible((current) => !current)} type="button">{visible ? '隐藏' : '显示'}</button>
      </div>
    </Field>
  );
}

export function OAuthConnectionFlow({ state }) {
  const { t } = useI18n();
  if (sourceForForm(state.form) === 'codex_login') return <CodexLoginReuse state={state} />;
  return (
    <section className="provider-flow-section">
      <FlowHeading badge="可选捷径" description={t('credential.storedHint')} title={t('credential.storedLogin')} />
      <CodexOAuthPanel state={state} />
      <p className="supervisor-oauth-note">助手快捷登录目前支持 Codex / ChatGPT。Claude Code 的本机登录请前往“编程工具”检查。</p>
    </section>
  );
}

function FlowHeading({ badge, description, title }) {
  return (
    <div className="provider-flow-heading">
      <div><h4>{title}</h4><p>{description}</p></div>
      <span>{badge}</span>
    </div>
  );
}

function ApiTypeField({ state }) {
  return (
    <Field hint="决定请求格式" label="API 协议">
      <select className="form-control" value={state.form.api} onChange={(event) => state.selectApiProtocol(event.target.value)}>
        <option value="openai-responses">OpenAI Responses</option>
        <option value="openai-completions">OpenAI Chat Completions</option>
        <option value="anthropic">Anthropic Messages</option>
        <option value="google">Google Gemini</option>
      </select>
    </Field>
  );
}
