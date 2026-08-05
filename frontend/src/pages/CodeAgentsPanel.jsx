import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Power, RefreshCw, Terminal } from 'lucide-react';
import { systemApi } from '../api/system.js';

const AGENT_DESCRIPTIONS = Object.freeze({
  codex: 'Codex CLI / Codex App 执行器',
  claude: 'Claude Code CLI / Claude Agent SDK 执行器',
  'pi-coding-agent': 'Pi Coding Agent RPC 执行器',
});

export default function CodeAgentsPanel() {
  const [state, setState] = useState({ agents: [], error: '', loading: true });
  const [busyAgentID, setBusyAgentID] = useState('');

  const load = useCallback(async (discover = false) => {
    setState(current => ({ ...current, error: '', loading: true }));
    try {
      const response = discover ? await systemApi.discoverCodeAgents() : await systemApi.getCodeAgents();
      setState({ agents: Array.isArray(response?.agents) ? response.agents : [], error: '', loading: false });
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
      setState({ agents: Array.isArray(response?.agents) ? response.agents : [], error: '', loading: false });
    } catch (error) {
      setState(current => ({ ...current, error: error.message || '更新 Code Agent 失败' }));
    } finally {
      setBusyAgentID('');
    }
  };

  return (
    <section className="code-agents-panel">
      <header className="code-agents-header">
        <div>
          <span className="connections-kicker"><Terminal size={14} /> Execution runtimes</span>
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
          <CodeAgentRow agent={agent} busy={busyAgentID === agent.id} key={agent.id} onToggle={toggle} />
        ))}
        {!state.loading && state.agents.length === 0 ? <div className="code-agents-empty">没有已注册的 Code Agent。</div> : null}
      </div>
    </section>
  );
}

function CodeAgentRow({ agent, busy, onToggle }) {
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
