import { sourceForForm } from './piCredentialSource.js';
import { CheckCircle2, CircleDashed, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { PanelLoader } from '../components/TurtleLoader';
import { usePiAgentSettingsState } from './piAgentSettingsState';
import { ProviderConnectionSettings } from './PiProviderConnectionSettings.jsx';
import { connectionApiLabel } from './piProviderConnectionLabels.js';
import { SupervisorBehaviorSettings } from './PiSupervisorBehaviorSettings.jsx';
import './PiAgentSettingsPanel.css';
export { CodexLoginReuse } from './PiCodexOAuthPanel.jsx';

export default function PiAgentSettingsPanel() {
  const state = usePiAgentSettingsState();
  return (
    <section className="supervisor-settings-panel">
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.loading ? <PanelLoader label="正在读取玄武助手配置…" /> : <SupervisorSettingsForm state={state} />}
    </section>
  );
}

function SupervisorSettingsForm({ state }) {
  return (
    <>
      <SupervisorReadiness state={state} />
      <ConfigurationStage
        description="填写模型服务提供的 API 地址和 Key，或使用账号快捷登录。获取并选择模型后，保存为默认模型。"
        index="01"
        title="连接助手模型"
      >
        <ProviderConnectionSettings state={state} />
      </ConfigurationStage>
      <ConfigurationStage
        description="设置玄武的名称、思考强度、工作指令，以及对话和通知的表达方式。"
        index="02"
        title="助手偏好"
      >
        <SupervisorBehaviorSettings state={state} />
      </ConfigurationStage>
    </>
  );
}

export function SupervisorReadiness({ state }) {
  const { t } = useI18n();
  const connectionSaved = Boolean(state.selectedProvider);
  const modelSelected = Boolean(state.form.modelId.trim());
  return (
    <div className="supervisor-readiness" aria-label="Xuanwu assistant readiness">
      <ReadinessItem label="Connection" ready={connectionSaved} value={sourceForForm(state.form) === 'codex_login' ? t('credential.reuse') : connectionSaved ? connectionApiLabel(state.form.api) : '待配置'} />
      <ReadinessItem label="Model" ready={modelSelected} value={modelSelected ? state.form.modelId : '待选择'} />
      <ReadinessItem label="玄武助手" ready={state.form.enabled} value={state.form.enabled ? '已启用' : '已停用'} />
    </div>
  );
}

function ReadinessItem({ label, ready, value }) {
  return (
    <div className={`supervisor-readiness-item ${ready ? 'ready' : ''}`}>
      {ready ? <CheckCircle2 size={13} /> : <CircleDashed size={13} />}
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function ConfigurationStage({ children, description, index, title }) {
  return (
    <section className="settings-configuration-stage supervisor-configuration-stage">
      <header className="settings-stage-header">
        <span>{index}</span>
        <div><h3>{title}</h3><p>{description}</p></div>
      </header>
      <div className="settings-stage-content">{children}</div>
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="supervisor-settings-header">
      <h3>玄武助手</h3>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading} type="button">
        <RefreshCw size={14} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}
