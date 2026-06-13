import { useEffect, useState } from 'react';
import { Bot, Loader2, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { statusLabel } from './piCommandCenterTerms';
import './PiAutomationStatusPanel.css';

export default function PiAutomationStatusPanel({ automation = {}, onChanged }) {
  const state = useAutomationSettings(onChanged);
  return (
    <section className="pi-automation-panel" aria-label="PI 定时巡检启用状态">
      <AutomationHeader loading={state.loading} onRefresh={state.load} />
      <AutomationLanes automation={automation} />
      <SupervisorPolicyTargets supervisor={automation.supervisor} />
      <ManagerTargets automation={automation} />
      <ManagerSettingsForm state={state} />
    </section>
  );
}

function useAutomationSettings(onChanged) {
  const [state, setState] = useState({ agents: [], error: '', form: blankForm(), loading: true, notice: '', projects: [], saving: false });
  const load = () => loadAutomationSettings(setState, state.form.projectId);
  useEffect(() => { loadAutomationSettings(setState, state.form.projectId); }, [state.form.projectId]);
  return { ...state, load, save: (event) => saveSettings(event, state.form, setState, load, onChanged), updateField: updateField(setState) };
}

async function loadAutomationSettings(setState, currentProjectId) {
  setState(prev => ({ ...prev, error: '', loading: true, notice: '' }));
  try {
    const [projects, agents] = await Promise.all([api.getProjects(), api.getPiAgents()]);
    const nextProjects = Array.isArray(projects) ? projects : [];
    const projectId = currentProjectId || nextProjects[0]?.id || '';
    const settings = projectId ? await api.getProjectPiSettings(projectId) : null;
    setState(prev => ({
      ...prev, agents: Array.isArray(agents) ? agents : [],
      form: formFromSettings(settings, projectId), loading: false, projects: nextProjects,
    }));
  } catch (err) {
    setState(prev => ({ ...prev, error: err.message || '读取 PI auto-manage 状态失败', loading: false }));
  }
}

function AutomationHeader({ loading, onRefresh }) {
  return (
    <div className="pi-automation-header">
      <div>
        <span className="pi-command-label">启用状态检查</span>
        <h2><ShieldCheck size={18} /> PI 定时巡检不是全量 issue 扫描</h2>
        <p>这里明确区分四条自动化链路，避免把 supervisor 故障恢复误读成“巡查所有 issue”。</p>
      </div>
      <button className="pi-command-refresh" disabled={loading} onClick={onRefresh} type="button">
        {loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} 刷新
      </button>
    </div>
  );
}

function AutomationLanes({ automation }) {
  const lanes = automationLanes(automation);
  return (
    <div className="pi-automation-lanes" aria-label="自动化链路区分">
      {lanes.map(lane => (
        <article className="pi-automation-lane" key={lane.title}>
          <span>{lane.title}</span>
          <strong>{lane.value}</strong>
          <p>{lane.detail}</p>
        </article>
      ))}
    </div>
  );
}

function SupervisorPolicyTargets({ supervisor = {} }) {
  const targets = Array.isArray(supervisor.targets) ? supervisor.targets : [];
  return (
    <div className="pi-supervisor-policy-targets" aria-label="Supervisor 自动恢复策略">
      <div>
        <strong>Supervisor mode 实际状态</strong>
        <p>{supervisor.reason || '默认只记录 watchdog 信号，不生成待审批动作'}；allowed actions：{actionList(supervisor.allowed_actions)}</p>
        <p>语义：off=关闭；watchdog=只记录信号；propose_only=只建议；assisted=需审批；autonomous=allowlist 内可自动恢复。</p>
      </div>
      <div className="pi-supervisor-policy-list">
        {targets.length === 0 ? <p className="pi-automation-empty">暂无项目策略。</p> : targets.map(target => <SupervisorTargetRow key={target.project_id} target={target} />)}
      </div>
    </div>
  );
}

function SupervisorTargetRow({ target }) {
  return (
    <article className={target.recovery_state === 'auto_recoverable' ? 'ready' : ''}>
      <div>
        <strong>{target.project_name || target.project_id}</strong>
        <p>{target.state_text}</p>
      </div>
      <code>{supervisorModeLabel(target.supervisor_mode)} · allowed={actionList(target.allowed_actions)}</code>
    </article>
  );
}

function ManagerTargets({ automation }) {
  const manager = automation.manager_auto_manage || {};
  const targets = Array.isArray(manager.targets) ? manager.targets : [];
  return (
    <div className="pi-automation-targets">
      <div>
        <strong>PI manager auto-manage（项目巡检）</strong>
        <p>{manager.reason || '等待 project_pi_settings 状态'}；heartbeat idle 的常见原因是没有项目开启 auto_manage、没有 active delegation 或没有 heartbeat cron。</p>
        <p>{manager.latest_cycle ? `最近 manager cycle：${manager.latest_cycle.status} · ${manager.latest_cycle.updated_at}` : '最近 manager cycle：暂无运行记录'}</p>
      </div>
      <div className="pi-automation-target-list">
        {targets.length === 0 ? <p className="pi-automation-empty">暂无项目，无法启用项目 PI auto-manage。</p> : targets.map(target => <TargetRow key={target.project_id} target={target} />)}
      </div>
    </div>
  );
}

function TargetRow({ target }) {
  return (
    <article className={target.runnable ? 'ready' : ''}>
      <div>
        <strong>{target.project_name || target.project_id}</strong>
        <p>{target.reason}</p>
      </div>
      <code>{target.settings_present ? `auto_manage=${target.auto_manage} · agent=${target.pi_agent_id || '未绑定'}` : 'project_pi_settings 未创建'}</code>
    </article>
  );
}

function ManagerSettingsForm({ state }) {
  return (
    <form className="pi-automation-form" onSubmit={state.save}>
      <div>
        <strong><Bot size={16} /> 启用项目 PI auto-manage / 绑定 agent / 设置巡检范围</strong>
        <p>当前巡检范围是项目级 manager cycle；不是巡查所有 issue。如要“所有 issue 巡查”，需单独设计范围、频率、limit、去重与成本预算。</p>
      </div>
      {state.error && <div className="pi-automation-error" role="alert">{state.error}</div>}
      {state.notice && <div className="pi-automation-success">{state.notice}</div>}
      <div className="pi-automation-form-grid">
        <ProjectSelect projects={state.projects} updateField={state.updateField} value={state.form.projectId} />
        <AgentSelect agents={state.agents} updateField={state.updateField} value={state.form.agentId} />
        <Field label="每轮最大动作数"><input className="form-control" min="1" type="number" value={state.form.maxActions} onChange={event => state.updateField('maxActions', event.target.value)} /></Field>
      </div>
      <label className="pi-automation-toggle">
        <input checked={state.form.autoManage} onChange={event => state.updateField('autoManage', event.target.checked)} type="checkbox" />
        启用 project_pi_settings.auto_manage=1，让 scheduler 定时运行 PI manager cycle
      </label>
      <div className="pi-automation-actions">
        <span>保存后可在 Command Center 看到 autonomous_projects、project_pi_settings 与 manager cycle 状态。</span>
        <button className="btn btn-primary" disabled={state.saving || !state.form.projectId} type="submit">
          {state.saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存 auto-manage 设置
        </button>
      </div>
    </form>
  );
}

function automationLanes(automation = {}) {
  return [
    lane('issue execution auto-run（todo 队列）', automation.issue_execution?.state, `${count(automation.issue_execution?.enabled_projects)} 个项目 auto_run=1；只负责领取 todo issue。`),
    lane('PI supervisor（故障 issue 恢复）', automation.supervisor?.state, supervisorLaneDetail(automation.supervisor)),
    lane('PI manager auto-manage（项目巡检）', automation.manager_auto_manage?.state, automation.manager_auto_manage?.reason || '未启用项目巡检。'),
    lane('delegation/cron heartbeat', heartbeatState(automation), heartbeatDetail(automation)),
  ];
}

function supervisorLaneDetail(supervisor = {}) {
  const auto = count(supervisor.automatic_projects);
  const approval = count(supervisor.needs_approval_projects);
  return `${supervisor.reason || '只扫描故障恢复候选'}；可自动恢复 ${auto} 个，需审批 ${approval} 个；scan=${supervisor.scan_scope || 'in_progress/open_issue_runs/due_auto_retry'}。`;
}

function lane(title, state, detail) {
  return { detail, title, value: statusLabel(state || 'idle') };
}

function heartbeatState(automation) {
  return automation.delegation_heartbeat?.state === 'enabled' || automation.cron_heartbeat?.state === 'enabled' ? 'running' : 'idle';
}

function heartbeatDetail(automation) {
  const delegations = count(automation.delegation_heartbeat?.active_delegations);
  const cron = count(automation.cron_heartbeat?.active_tasks);
  return `${delegations} 个 active delegation，${cron} 个 heartbeat cron；都为 0 时 heartbeat idle。`;
}

function ProjectSelect({ projects, updateField, value }) {
  return <Field label="项目"><select className="form-control" required value={value} onChange={event => updateField('projectId', event.target.value)}>
    <option value="">选择项目</option>
    {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
  </select></Field>;
}

function AgentSelect({ agents, updateField, value }) {
  const enabledAgents = agents.filter(agent => agent.enabled === 1);
  return <Field label="PI agent"><select className="form-control" required value={value} onChange={event => updateField('agentId', event.target.value)}>
    <option value="">选择 enabled PI agent</option>
    {enabledAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
  </select></Field>;
}

function Field({ children, label }) {
  return <label className="pi-automation-field">{label}{children}</label>;
}

function updateField(setState) {
  return (field, value) => setState(prev => ({ ...prev, form: { ...prev.form, [field]: value }, notice: '' }));
}

async function saveSettings(event, form, setState, load, onChanged) {
  event.preventDefault();
  setState(prev => ({ ...prev, error: '', notice: '', saving: true }));
  try {
    await api.updateProjectPiSettings(form.projectId, settingsPayload(form));
    await load();
    onChanged?.();
    setState(prev => ({ ...prev, notice: '项目 PI auto-manage 设置已保存', saving: false }));
  } catch (err) {
    setState(prev => ({ ...prev, error: err.message || '保存 PI auto-manage 设置失败', saving: false }));
  }
}

function settingsPayload(form) {
  return {
    auto_manage: form.autoManage,
    max_actions_per_cycle: Math.max(1, Number(form.maxActions) || 5),
    pi_agent_id: form.agentId,
  };
}

function formFromSettings(settings, projectId) {
  return {
    agentId: settings?.pi_agent_id || '',
    autoManage: settings?.auto_manage === 1,
    maxActions: String(settings?.max_actions_per_cycle || 5),
    projectId,
  };
}

function blankForm(projectId = '') {
  return { agentId: '', autoManage: false, maxActions: '5', projectId };
}

function count(value) {
  return Number(value || 0);
}

function actionList(value) {
  const list = Array.isArray(value) ? value.filter(Boolean) : [];
  return list.length > 0 ? list.join(', ') : '空（不会自动续聊）';
}

function supervisorModeLabel(mode) {
  const labels = {
    assisted: '需审批',
    autonomous: '可自动恢复',
    off: '关闭',
    propose_only: '只建议',
    watchdog: 'watchdog',
  };
  return labels[mode] || mode || '未配置';
}
