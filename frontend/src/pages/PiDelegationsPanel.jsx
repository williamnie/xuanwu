import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pause, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';

const DEFAULT_ALLOWED_ACTIONS = 'issue.enqueue, issue.state_repair, session.read_summary';
const DEFAULT_WINDOW_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;

function initialForm(projectId = '') {
  return {
    allowedActions: DEFAULT_ALLOWED_ACTIONS,
    expiresAt: localInputFromDate(new Date(Date.now() + DEFAULT_WINDOW_HOURS * HOUR_MS)),
    forbiddenActions: 'session.steer',
    issueIds: '',
    projectId,
    startsAt: localInputFromDate(new Date()),
    title: '',
  };
}

export default function PiDelegationsPanel({ onChanged }) {
  const state = usePiDelegationsState(onChanged);
  return (
    <section className="pi-command-module pi-delegations-panel" aria-label="Delegations">
      <PanelHeader loading={state.loading} onRefresh={state.load} />
      {state.error && <InlineError>{state.error}</InlineError>}
      <DelegationForm
        error={state.formError}
        form={state.form}
        onSubmit={state.handleSubmit}
        projects={state.projects}
        submitting={state.submitting}
        updateField={state.updateField}
      />
      <DelegationList
        delegations={state.delegations}
        loading={state.loading}
        mutatingId={state.mutatingId}
        onToggle={state.handleToggle}
        projectLabelMap={state.projectLabelMap}
      />
    </section>
  );
}

function usePiDelegationsState(onChanged) {
  const data = useDelegationData();
  const formState = useDelegationForm(data.load, data.projects, onChanged);
  const statusState = useDelegationStatusMutation(data.load, data.setError, onChanged);
  return { ...data, ...formState, ...statusState };
}

function useDelegationData() {
  const [delegations, setDelegations] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [nextProjects, nextDelegations] = await Promise.all([api.getProjects(), api.getPiDelegations()]);
      setProjects(Array.isArray(nextProjects) ? nextProjects : []);
      setDelegations(Array.isArray(nextDelegations) ? nextDelegations : []);
    } catch (err) {
      setError(err.message || '读取 Delegations 失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const projectLabelMap = useMemo(() => new Map(projects.map(project => [project.id, project.name || project.id])), [projects]);
  return { delegations, error, load, loading, projectLabelMap, projects, setError };
}

function useDelegationForm(load, projects, onChanged) {
  const [form, setForm] = useState(() => initialForm());
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  useEffect(() => { setDefaultProject(projects, setForm); }, [projects]);
  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      await api.createPiDelegation(buildCreatePayload(form));
      await load();
      onChanged?.();
      setForm(initialForm(form.projectId));
    } catch (err) {
      setFormError(err.message || '创建 delegation 失败');
    } finally {
      setSubmitting(false);
    }
  };
  return { form, formError, handleSubmit, submitting, updateField };
}

function useDelegationStatusMutation(load, setError, onChanged) {
  const [mutatingId, setMutatingId] = useState('');
  const handleToggle = async (delegation) => {
    setError('');
    setMutatingId(delegation.id);
    try {
      if (delegation.status === 'active') await api.pausePiDelegation(delegation.id);
      if (delegation.status === 'paused') await api.resumePiDelegation(delegation.id);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || '更新 delegation 状态失败');
    } finally {
      setMutatingId('');
    }
  };
  return { handleToggle, mutatingId };
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="pi-delegations-header">
      <div>
        <h2><ShieldCheck size={18} /> Delegations</h2>
        <p>创建限定 issue、时间窗口与 action allowlist 的 delegated window，并可暂停/恢复。</p>
      </div>
      <button className="pi-command-refresh" disabled={loading} onClick={onRefresh} type="button">
        {loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
        Refresh
      </button>
    </div>
  );
}

function DelegationForm({ error, form, onSubmit, projects, submitting, updateField }) {
  return (
    <form className="pi-delegations-form" onSubmit={onSubmit}>
      {error && <InlineError>{error}</InlineError>}
      <label>Project<select className="form-control" required value={form.projectId} onChange={event => updateField('projectId', event.target.value)}>
        <option value="">选择项目</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
      </select></label>
      <label>Issue IDs<input className="form-control" placeholder="#265, #266" value={form.issueIds} onChange={event => updateField('issueIds', event.target.value)} /></label>
      <label>Starts<input className="form-control" type="datetime-local" value={form.startsAt} onChange={event => updateField('startsAt', event.target.value)} /></label>
      <label>Expires<input className="form-control" required type="datetime-local" value={form.expiresAt} onChange={event => updateField('expiresAt', event.target.value)} /></label>
      <label className="pi-delegations-wide">Allowed actions<input className="form-control" value={form.allowedActions} onChange={event => updateField('allowedActions', event.target.value)} /></label>
      <label>Forbidden actions<input className="form-control" value={form.forbiddenActions} onChange={event => updateField('forbiddenActions', event.target.value)} /></label>
      <label>Title<input className="form-control" placeholder="Night delegated window" value={form.title} onChange={event => updateField('title', event.target.value)} /></label>
      <button className="btn btn-primary" disabled={submitting} type="submit">
        {submitting ? 'Creating…' : 'Create delegated window'}
      </button>
    </form>
  );
}

function DelegationList({ delegations, loading, mutatingId, onToggle, projectLabelMap }) {
  if (loading && delegations.length === 0) return <div className="pi-delegations-empty"><Loader2 size={14} className="spin-animation" /> Loading delegations…</div>;
  if (delegations.length === 0) return <div className="pi-delegations-empty">暂无 delegation window。</div>;
  return (
    <div className="pi-delegations-list">
      {delegations.map(delegation => (
        <DelegationRow
          delegation={delegation}
          key={delegation.id}
          mutating={mutatingId === delegation.id}
          onToggle={onToggle}
          projectName={projectLabelMap.get(delegation.project_id) || delegation.project_id}
        />
      ))}
    </div>
  );
}

function DelegationRow({ delegation, mutating, onToggle, projectName }) {
  const scope = parseJsonObject(delegation.scope_json);
  const issueIds = Array.isArray(scope.issue_ids) ? scope.issue_ids : [];
  const allowedActions = parseJsonArray(delegation.allowed_actions_json);
  const forbiddenActions = parseJsonArray(delegation.forbidden_actions_json);
  const canToggle = delegation.status === 'active' || delegation.status === 'paused';
  return (
    <article className="pi-delegations-row">
      <div className="pi-delegations-row-main">
        <div className="pi-delegations-row-title">
          <strong>{delegation.title || delegation.id}</strong>
          <span className={`status-badge ${statusClass(delegation.status)}`}>{delegation.status}</span>
        </div>
        <p>{projectName} · {windowLabel(delegation)}</p>
        <ChipLine label="Issues" values={issueIds.map(String)} empty="project scope" />
        <ChipLine label="Allowed" values={allowedActions} empty="none" />
        <ChipLine label="Forbidden" values={forbiddenActions} empty="none" />
      </div>
      {canToggle && (
        <button className="btn btn-secondary" disabled={mutating} onClick={() => onToggle(delegation)} type="button">
          {mutating ? <Loader2 size={14} className="spin-animation" /> : delegation.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
          {delegation.status === 'active' ? 'Pause' : 'Resume'}
        </button>
      )}
    </article>
  );
}

function ChipLine({ empty, label, values }) {
  const items = values.filter(Boolean);
  return (
    <div className="pi-delegations-chips"><span>{label}</span>
      {(items.length > 0 ? items : [empty]).map(value => <code key={`${label}-${value}`}>{value}</code>)}
    </div>
  );
}

function InlineError({ children }) {
  return <div className="pi-delegations-error" role="alert">{children}</div>;
}

function buildCreatePayload(form) {
  const projectId = form.projectId.trim();
  if (!projectId) throw new Error('请选择项目');
  const issueIds = parseIssueIds(form.issueIds);
  const allowedActions = parseActions(form.allowedActions);
  if (allowedActions.length === 0) throw new Error('至少填写一个 allowed action');
  const startsAt = isoFromLocal(form.startsAt, 'starts_at');
  const expiresAt = isoFromLocal(form.expiresAt, 'expires_at');
  if (startsAt && expiresAt && startsAt >= expiresAt) throw new Error('expires_at 必须晚于 starts_at');
  const scope = issueIds.length > 0 ? { issue_ids: issueIds, project_id: projectId } : { project_id: projectId };
  const forbiddenActions = parseActions(form.forbiddenActions);
  return {
    allowed_actions: allowedActions,
    audit_source: 'command-center',
    authorization: { allowed_actions: allowedActions, audit_source: 'command-center', forbidden_actions: forbiddenActions, mode: 'delegated', scope, starts_at: startsAt, expires_at: expiresAt },
    expires_at: expiresAt,
    forbidden_actions: forbiddenActions,
    project_id: projectId,
    scope,
    starts_at: startsAt,
    title: form.title.trim() || defaultTitle(issueIds),
  };
}

function setDefaultProject(projects, setForm) {
  const firstProject = Array.isArray(projects) ? projects[0]?.id || '' : '';
  if (!firstProject) return;
  setForm(prev => (prev.projectId ? prev : { ...prev, projectId: firstProject }));
}

function parseIssueIds(value) {
  return [...new Set((value.match(/#?\d+/g) || []).map(item => Number(item.replace('#', ''))).filter(Number.isInteger))];
}

function parseActions(value) {
  return value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
}

function isoFromLocal(value, label) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} 不是合法时间`);
  return date.toISOString();
}

function localInputFromDate(date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function defaultTitle(issueIds) {
  return issueIds.length > 0 ? `Delegated issues ${issueIds.map(id => `#${id}`).join(', ')}` : 'Project delegated window';
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function statusClass(status) {
  if (status === 'active') return 'done';
  if (status === 'paused') return 'todo';
  return 'cancelled';
}

function windowLabel(delegation) {
  return `${formatTime(delegation.starts_at) || 'now'} → ${formatTime(delegation.expires_at) || 'open-ended'}`;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
