import { codexLoginMessage, sourceForForm } from './piCredentialSource.js';
import { useI18n } from '../i18n/context.js';
import { piConnectionStatus } from './piConnectionStatus.js';
import { connectionTarget } from './piProviderConnectionLabels.js';

export function ConnectionProgress({ oauthMode, state }) {
  const { language, t } = useI18n();
  const reuse = oauthMode && sourceForForm(state.form) === 'codex_login';
  const english = language === 'en-US';
  const status = piConnectionStatus(state);
  const modelStatus = {
    untested: english ? 'Not tested' : '未测试',
    passed: english ? 'Tested and available' : '已测试可用',
    failed: english ? 'Test failed' : '测试失败',
    testing: english ? 'Testing…' : '测试中…',
  }[status.model];
  return (
    <aside className="provider-progress-rail">
      <span className="provider-console-label">{english ? 'Connection status' : '连接状态'}</span>
      <div className="provider-progress-list" role="status">
        <ProgressStep index="1" label={english ? 'Authorization' : '授权'} ready={status.authorized} value={reuse ? t('credential.authorization', { status: t(codexLoginMessage(state.oauthStatus?.codex_login)) }) : status.authorized ? (english ? 'Authorized' : '已授权') : (english ? 'Not authorized' : '未授权')} />
        <ProgressStep index="2" label={english ? 'Model' : '模型'} ready={status.model === 'passed'} value={modelStatus} />
      </div>
      <div className="provider-connection-summary">
        <span>{english ? 'Selected connection' : '当前连接'}</span>
        <dl>
          <div><dt>{english ? 'Auth' : '认证'}</dt><dd>{reuse ? t('credential.reuse') : oauthMode ? 'Codex OAuth' : 'API Key'}</dd></div>
          <div><dt>{english ? 'API' : '协议'}</dt><dd>{state.form.api}</dd></div>
          <div><dt>{english ? 'URL' : '地址'}</dt><dd>{oauthMode ? (english ? 'Configured by OAuth' : 'OAuth 自动配置') : connectionTarget(state.form.baseUrl)}</dd></div>
          <div><dt>{english ? 'Model' : '模型'}</dt><dd>{state.form.modelId || (english ? 'Choose a model' : '待选择')}</dd></div>
        </dl>
      </div>
    </aside>
  );
}

function ProgressStep({ index, label, ready, value }) {
  return (
    <div className={`provider-progress-step ${ready ? 'ready' : ''}`}>
      <span>{ready ? '✓' : index}</span>
      <div><strong>{label}</strong><small>{value}</small></div>
    </div>
  );
}
