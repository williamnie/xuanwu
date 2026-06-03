import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Command, FileText, Loader2, Pause, Play, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { piActionGateApi } from '../api/piActionGateClient';
import { message } from '../store/toastStore';
import './PiCommandCenter.css';
const TABS = ['Delegations', 'Approvals', 'Heartbeat Timeline', 'Policy', 'Reports']; const SNOOZE_MS = 60 * 60 * 1000;
export default function PiCommandCenter() {
  const state = useCommandCenterState();
  return (
    <div className="pi-command-center animate-fade-in">
      <Hero state={state} />
      <TabBar active={state.tab} setActive={state.setTab} />
      {state.error && <div className="pi-command-error">{state.error}</div>}
      {state.tab === 'Delegations' && <Delegations state={state} />}
      {state.tab === 'Approvals' && <Approvals state={state} />}
      {state.tab === 'Heartbeat Timeline' && <HeartbeatTimeline state={state} />}
      {state.tab === 'Policy' && <Policy state={state} />}
      {state.tab === 'Reports' && <Reports state={state} />}
    </div>
  );
}
function useCommandCenterState() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ allowed: 'issue.enqueue, issue.state_repair', project_id: '', title: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState('');
  const [tab, setTab] = useState('Delegations');
  const load = useCallback(async () => {
    try {
      const [center, usage] = await Promise.all([api.getPiCommandCenter(), api.getCodexUsage(200).catch(() => null)]);
      setData({ ...center, usage });
      setDraft(prev => ({ ...prev, project_id: prev.project_id || center.projects?.[0]?.id || '' }));
      setError('');
    } catch (err) {
      setError(err.message || '读取 PI Command Center 失败');
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => api.subscribeToEvents((event) => {
    if (String(event?.type || '').startsWith('pi.') || String(event?.type || '').startsWith('issue.')) load();
  }), [load]);
  const run = useCallback(async (key, action) => {
    setSubmitting(key);
    try { await action(); message.success('Command Center 已更新'); await load(); }
    catch (err) { message.error(err.message || 'Command Center 操作失败'); }
    finally { setSubmitting(''); }
  }, [load]);
  return { data, draft, error, load, run, setDraft, setTab, submitting, tab };
}
function Hero({ state }) {
  const overview = state.data?.overview || {};
  const heartbeat = state.data?.heartbeat?.recent_runs?.[0]?.status || 'idle';
  const cards = [
    ['Mode', state.data?.mode || 'manual'],
    ['Active delegations', overview.active_delegations || 0],
    ['Heartbeat status', heartbeat],
    ['Pending approvals', overview.pending_approvals || 0],
    ['Running issue', overview.running_issues || 0],
  ];
  return (
    <section className="pi-command-hero">
      <div>
        <span className="pi-command-kicker">PI OpenClaw P11</span>
        <h1>Command Center</h1>
        <p>集中查看 PI 是否处于自动代理、授权范围、审批队列、heartbeat 证据与每日/失败/用量报告。</p>
      </div>
      <div className="pi-command-grid">
        {cards.map(([label, value]) => (
          <div className="pi-command-card" key={label}>
            <span className="pi-command-label">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
function TabBar({ active, setActive }) {
  return (
    <nav className="pi-command-tabs" aria-label="PI Command Center modules">
      {TABS.map(tab => <button key={tab} className={`pi-command-tab ${active === tab ? 'active' : ''}`} onClick={() => setActive(tab)}>{tab}</button>)}
    </nav>
  );
}
function Delegations({ state }) {
  const delegations = state.data?.delegations || [];
  return (
    <Module icon={<ShieldCheck size={18} />} title="Delegations">
      <form className="pi-command-form" onSubmit={(event) => createDelegation(event, state)}>
        <select className="form-control" value={state.draft.project_id} onChange={event => patchDraft(state, 'project_id', event.target.value)}>
          {(state.data?.projects || []).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <input className="form-control" placeholder="授权窗口标题" value={state.draft.title} onChange={event => patchDraft(state, 'title', event.target.value)} />
        <input
          className="form-control"
          placeholder="allowed actions，逗号分隔"
          value={state.draft.allowed}
          onChange={event => patchDraft(state, 'allowed', event.target.value)}
        />
        <button className="btn btn-primary" disabled={Boolean(state.submitting)}>Create</button>
      </form>
      <List rows={delegations} empty="暂无 delegation。">
        {delegation => <DelegationRow key={delegation.id} delegation={delegation} state={state} />}
      </List>
    </Module>
  );
}
function DelegationRow({ delegation, state }) {
  const active = delegation.status === 'active';
  const auth = parseJSON(delegation.authorization_json);
  return (
    <Row
      title={delegation.title || delegation.id}
      badge={delegation.status}
      actions={<ActionButton
        icon={active ? <Pause size={14} /> : <Play size={14} />}
        label={active ? 'Pause' : 'Resume'}
        onClick={() => toggleDelegation(state, delegation.id, active)}
        busy={state.submitting === `delegation:${delegation.id}`}
      />}
    >
      <p>
        {delegation.project_id} · next heartbeat {time(delegation.next_heartbeat_at)} ·
        allowed {(auth.allowed_actions || auth.allowedActions || []).join(', ') || '未限制'}
      </p>
    </Row>
  );
}
function Approvals({ state }) {
  const approvals = state.data?.pending_approvals || [];
  return (
    <Module icon={<CheckCircle2 size={18} />} title="Approvals">
      <List rows={approvals} empty="暂无 pending approvals。">
        {action => <ApprovalRow key={action.id} action={action} state={state} />}
      </List>
    </Module>
  );
}
function ApprovalRow({ action, state }) {
  return (
    <Row
      title={action.action_type}
      badge={action.risk_level || 'low'}
      actions={['approve', 'request_changes', 'snooze', 'reject'].map(decision => (
        <ActionButton key={decision} label={decisionLabel(decision)} onClick={() => decide(state, action.id, decision)} busy={state.submitting === `${action.id}:${decision}`} />
      ))}
    >
      <p>{action.rationale || action.gate_reason || '等待用户审批。'} · issue #{action.issue_id || '—'}</p>
    </Row>
  );
}
function HeartbeatTimeline({ state }) {
  const events = state.data?.heartbeat?.recent_events || [];
  return (
    <Module icon={<Activity size={18} />} title="Heartbeat Timeline">
      <List rows={events} empty="暂无 heartbeat event。">
        {event => (
          <Row key={event.id} title={event.event_type} badge={time(event.created_at)}>
            <p>{event.message || event.error || summarize(event.payload_json)} · {event.project_id || 'global'}</p>
          </Row>
        )}
      </List>
    </Module>
  );
}
function Policy({ state }) {
  const settings = new Map((state.data?.pi_settings || []).map(item => [item.project_id, item]));
  return (
    <Module icon={<Command size={18} />} title="Policy">
      <List rows={state.data?.projects || []} empty="暂无 project policy。">
        {project => (
          <PolicyRow
            key={project.id}
            delegations={state.data?.delegations || []}
            project={project}
            schedules={state.data?.cron_tasks || []}
            settings={settings.get(project.id)}
            state={state}
          />
        )}
      </List>
    </Module>
  );
}
function PolicyRow({ delegations, project, schedules, settings, state }) {
  const skill = parseJSON(project.default_skill_policy);
  const mcp = parseJSON(project.default_mcp_policy);
  const auto = settings?.auto_manage === 1;
  const allowedActions = projectAllowedActions(delegations, project.id);
  const workHours = workingHoursPolicy(schedules, project.id);
  return (
    <Row
      title={project.name}
      badge={auto ? 'delegated' : 'manual'}
      actions={<ActionButton
        icon={auto ? <Pause size={14} /> : <Play size={14} />}
        label={auto ? 'Pause autonomous' : 'Resume autonomous'}
        onClick={() => toggleAutonomousMode(state, project.id, auto)}
        busy={state.submitting === `auto:${project.id}`}
      />}
    >
      <p>
        approval {project.approval_policy} · work hours {workHours} ·
        allowed actions {allowedActions.join(', ') || '空'} · skill allowlist {(skill.allowed || []).join(', ') || '空'} ·
        MCP allowlist {(mcp.allowed || []).join(', ') || '空'}
      </p>
    </Row>
  );
}
function Reports({ state }) {
  const report = state.data?.reports || {};
  const usage = state.data?.usage?.summary?.today;
  const daily = report.daily_summary || {};
  return (
    <Module icon={<FileText size={18} />} title="Reports">
      <div className="pi-command-grid">
        <ReportCard label="daily summary" value={Object.entries(daily).map(([k, v]) => `${k}:${v}`).join(' · ') || '无 issue'} />
        <ReportCard label="failure summary" value={`${report.failure_summary?.count || 0} failed`} />
        <ReportCard label="usage/cost summary" value={`${usage?.total_tokens || 0} tokens today`} />
        <ReportCard label="nightly execution" value={`${report.nightly?.length || 0} report tasks`} />
      </div>
    </Module>
  );
}
function Module({ children, icon, title }) {
  return <section className="pi-command-module"><h2>{icon}{title}</h2>{children}</section>;
}
function List({ children, empty, rows }) {
  if (!rows || rows.length === 0) return <div className="pi-command-empty">{empty}</div>;
  return <div className="pi-command-list">{rows.map(children)}</div>;
}
function Row({ actions = null, badge, children, title }) {
  return (
    <article className="pi-command-row">
      <div>
        <div className="pi-command-title">
          <strong>{title}</strong>
          <span className="status-badge todo">{badge}</span>
        </div>
        {children}
      </div>
      {actions && <div className="pi-command-actions">{actions}</div>}
    </article>
  );
}
function ActionButton({ busy, icon, label, onClick }) {
  return <button className="btn btn-secondary" disabled={busy} onClick={onClick}>{busy ? <Loader2 size={14} className="spin-animation" /> : icon}{label}</button>;
}
function ReportCard({ label, value }) {
  return <div className="pi-command-card"><span className="pi-command-label">{label}</span><p>{value}</p></div>;
}
function createDelegation(event, state) {
  event.preventDefault();
  const allowed = state.draft.allowed.split(',').map(item => item.trim()).filter(Boolean);
  return state.run('create-delegation', () => api.createPiDelegation({
    authorization: { allowed_actions: allowed, mode: 'delegated' },
    intent: { source: 'command-center' },
    project_id: state.draft.project_id,
    title: state.draft.title || 'Command Center delegation'
  }));
}
function toggleDelegation(state, id, active) {
  return state.run(`delegation:${id}`, () => active ? api.pausePiDelegation(id) : api.resumePiDelegation(id));
}
function toggleAutonomousMode(state, id, auto) {
  return state.run(`auto:${id}`, () => (
    auto ? api.pauseProjectPiAutonomousMode(id) : api.resumeProjectPiAutonomousMode(id)
  ));
}
function decide(state, id, decision) {
  return state.run(`${id}:${decision}`, () => {
    if (decision === 'approve') return piActionGateApi.approve(id);
    if (decision === 'reject') return piActionGateApi.reject(id);
    if (decision === 'snooze') return piActionGateApi.snooze(id, 'Command Center snooze', new Date(Date.now() + SNOOZE_MS).toISOString());
    return piActionGateApi.requestChanges(id, '请 PI 补充范围、验证方式或降级风险。');
  });
}
function patchDraft(state, key, value) { state.setDraft(prev => ({ ...prev, [key]: value })); }
function decisionLabel(value) { return value === 'request_changes' ? 'Request changes' : value[0].toUpperCase() + value.slice(1); }
function parseJSON(text) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
function summarize(text) {
  const data = parseJSON(text); return data.summary || data.reason || '';
}
function projectAllowedActions(delegations, projectId) {
  const values = delegations.filter(item => item.project_id === projectId).flatMap(item => {
    const auth = parseJSON(item.authorization_json);
    return auth.allowed_actions || auth.allowedActions || [];
  });
  return [...new Set(values)];
}
function workingHoursPolicy(schedules, projectId) {
  const task = schedules.find(item => item.project_id === projectId || item.project_id === '');
  if (!task) return '未配置';
  const hours = parseJSON(task.working_hours_json);
  return Object.keys(hours).length === 0 ? '未配置' : JSON.stringify(hours);
}
function time(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(); }
