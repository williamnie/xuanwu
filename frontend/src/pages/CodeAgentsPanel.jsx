import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Monitor, Power, RefreshCw, Terminal } from 'lucide-react';
import { systemApi } from '../api/system.js';
import { message } from '../store/toastStore.js';
import { codexBackendChoices, codexBackendUpdatePayload } from '../utils/codexBackends.js';
import './CodeAgentsPanel.css';

const AGENT_DESCRIPTIONS = Object.freeze({
  codex: 'Codex CLI / Codex App 执行器',
  claude: 'Claude Code CLI / Claude Agent SDK 执行器',
  'pi-coding-agent': 'Pi Coding Agent RPC 执行器',
  qoder: 'Qoder Agent SDK / qodercli 执行器',
});

export default function CodeAgentsPanel() {
  const [state, setState] = useState({ agents: [], error: '', loading: true, runnerSettings: null });
  const [busyAgentID, setBusyAgentID] = useState('');

  const load = useCallback(async (discover = false) => {
    setState(current => ({ ...current, error: '', loading: true }));
    try {
      const [response, runnerSettings] = await Promise.all([
        discover ? systemApi.discoverCodeAgents() : systemApi.getCodeAgents(),
        systemApi.getRunnerSettings(),
      ]);
      setState({ agents: Array.isArray(response?.agents) ? response.agents : [], error: '', loading: false, runnerSettings });
    } catch (error) {
      setState(current => ({ ...current, error: error.message || '读取 Code Agents 失败', loading: false }));
    }
  }, []);

  useEffect(() => { load(true); }, [load]);

  const toggle = async (agent) => {
    setBusyAgentID(agent.id);
    setState(current => ({ ...current, error: '' }));
    try {
      const response = await systemApi.updateCodeAgent(agent.id, !agent.enabled);
      setState(current => ({ ...current, agents: Array.isArray(response?.agents) ? response.agents : [], error: '', loading: false }));
    } catch (error) {
      setState(current => ({ ...current, error: error.message || '更新 Code Agent 失败' }));
    } finally {
      setBusyAgentID('');
    }
  };

  const selectCodexBackend = async (mode) => {
    setBusyAgentID('codex-backend');
    setState(current => ({ ...current, error: '' }));
    try {
      const runnerSettings = await systemApi.updateRunnerSettings(codexBackendUpdatePayload(mode));
      const response = await systemApi.discoverCodeAgents();
      setState({ agents: Array.isArray(response?.agents) ? response.agents : [], error: '', loading: false, runnerSettings });
      if (runnerSettings?.runtime_apply?.codexTransport === 'deferred_active_sessions') {
        message.warning('Codex app-server 选择已保存；当前 Session 结束后请再次选择，或重启服务以切换 transport');
      } else {
        message.success(`新的 Codex 任务将使用 ${mode === 'app' ? 'Codex App' : 'Codex CLI'} app-server`);
      }
    } catch (error) {
      setState(current => ({ ...current, error: error.message || '更新 Codex app-server 失败' }));
    } finally {
      setBusyAgentID('');
    }
  };

  return (
    <section className="code-agents-panel">
      <header className="code-agents-header">
        <div>
          <span className="code-agents-kicker"><Terminal size={14} /> Execution runtimes</span>
          <h2>Code Agents</h2>
          <p>自动探测本机已注册的代码执行器。只有已启用且可用的 Agent 才会出现在新建 Issue、Work、Project 和 Profile 的选择器中。</p>
        </div>
        <button className="btn btn-secondary" disabled={state.loading || Boolean(busyAgentID)} onClick={() => load(true)} type="button">
          <RefreshCw className={state.loading ? 'spin-animation' : ''} size={15} /> 重新发现
        </button>
      </header>

      {state.error ? <div className="code-agents-error" role="alert">{state.error}</div> : null}
      <div className="code-agents-list">
        {state.agents.map(agent => (
          <CodeAgentRow
            agent={agent}
            busy={busyAgentID === agent.id || (agent.id === 'codex' && busyAgentID === 'codex-backend')}
            key={agent.id}
            onSelectCodexBackend={selectCodexBackend}
            onToggle={toggle}
            runnerSettings={state.runnerSettings}
          />
        ))}
        {!state.loading && state.agents.length === 0 ? <div className="code-agents-empty">没有已注册的 Code Agent。</div> : null}
      </div>
    </section>
  );
}

function CodeAgentRow({ agent, busy, onSelectCodexBackend, onToggle, runnerSettings }) {
  const available = agent.enabled && agent.submittable;
  const status = agent.enabled ? (available ? '可用' : '未就绪') : '已停用';
  return (
    <article className="code-agent-row">
      <div className={`code-agent-status ${available ? 'available' : ''}`}>
        {available ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
      </div>
      <div className="code-agent-copy">
        <div className="code-agent-title">
          <strong>{agent.label || agent.id}</strong>
          <span className={available ? 'available' : ''}>{status}</span>
        </div>
        <p>{AGENT_DESCRIPTIONS[agent.id] || agent.id}</p>
        {agent.enabled && !available && agent.readiness_reason ? <small>{agent.readiness_reason}</small> : null}
        {agent.id === 'qoder' ? <QoderDiagnostics runtime={agent.runtime} /> : null}
        {agent.id === 'codex' ? (
          <CodexBackendSelector busy={busy || !agent.enabled} onSelect={onSelectCodexBackend} settings={runnerSettings} />
        ) : null}
      </div>
      <button
        className={`btn ${agent.enabled ? 'btn-secondary' : 'btn-primary'}`}
        disabled={busy}
        onClick={() => onToggle(agent)}
        type="button"
      >
        <Power size={14} /> {busy ? '处理中…' : agent.enabled ? '停用' : '启用'}
      </button>
    </article>
  );
}

function QoderDiagnostics({ runtime }) {
  const platform = runtime?.platform_profile || {};
  const diagnostics = [
    ['CLI', runtime?.executable_ready ? platform.cli_version || '已就绪' : platform.cli_version || '不可用'],
    ['SDK', platform.sdk_ready === false ? '不可用' : platform.sdk_version || runtime?.version || '未知'],
    ['认证', runtime?.auth_configured ? `${runtime.auth_mode || 'configured'} · ${runtime.auth_source || 'configured'}` : runtime?.auth_mode ? `${runtime.auth_mode} · 未配置` : '未配置'],
    ['协议', platform.protocol_status ? `${platform.protocol_status}${platform.protocol_version ? ` · ${platform.protocol_version}` : ''}` : '未知'],
  ];
  return (
    <dl className="code-agent-diagnostics" aria-label="Qoder runtime diagnostics">
      {diagnostics.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

function CodexBackendSelector({ busy, onSelect, settings }) {
  const choices = codexBackendChoices(settings || {});
  return (
    <div className="codex-backend-selector">
      <div className="codex-backend-heading">
        <strong>Codex app-server</strong>
        <span>同一个 Codex Code Agent 的运行后端；历史 Provider / Session 标识保持不变。</span>
      </div>
      <div className="codex-backend-options">
        {choices.map(choice => (
          <button
            aria-pressed={choice.active}
            className={`codex-backend-option ${choice.active ? 'active' : ''}`}
            disabled={busy || choice.active || !choice.status.ready}
            key={choice.id}
            onClick={() => onSelect(choice.id)}
            type="button"
          >
            <span className="codex-backend-option-title">
              {choice.id === 'app' ? <Monitor size={15} /> : <Terminal size={15} />}
              <strong>{choice.label}</strong>
              {choice.active ? <em>当前默认</em> : null}
            </span>
            <span>{choice.description}</span>
            <small className={choice.status.ready ? 'ready' : ''}>
              {choice.status.ready ? '可用' : '未就绪'} · {choice.status.detail}
            </small>
          </button>
        ))}
      </div>
      <p className="codex-backend-note">每次只选择一个默认 app-server；不会在 CLI 与 App 不可用时静默 fallback。</p>
    </div>
  );
}
