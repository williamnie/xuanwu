import { useCallback, useEffect, useState } from 'react';
import { BellOff, Loader2, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import './PiGuardianPreferencesPanel.css';

function initialForm(defaultProjectId = '') {
  return {
    expiresAt: '',
    mode: 'quiet',
    notifyOn: 'needs_user,budget_exhausted,urgent',
    projectId: defaultProjectId,
    scope: 'project',
    ttlMinutes: '480',
  };
}

export default function PiGuardianPreferencesPanel() {
  const state = useGuardianPreferenceState();
  return (
    <section className="pi-command-module pi-guardian-preferences-panel" aria-label="通知偏好">
      <PreferenceHeader loading={state.loading} onRefresh={state.load} />
      {state.error && <InlineError>{state.error}</InlineError>}
      <PreferenceForm state={state} />
      <PreferenceList preferences={state.preferences} loading={state.loading} mutatingId={state.mutatingId} onDisable={state.disablePreference} />
    </section>
  );
}

function useGuardianPreferenceState() {
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => initialForm());
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mutatingId, setMutatingId] = useState('');
  const [preferences, setPreferences] = useState([]);
  const [projects, setProjects] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [nextProjects, nextPreferences] = await Promise.all([
        api.getProjects(),
        api.getPiGuardianPreferences({ status: 'active' }),
      ]);
      setProjects(Array.isArray(nextProjects) ? nextProjects : []);
      setPreferences(Array.isArray(nextPreferences) ? nextPreferences : []);
    } catch (err) {
      setError(err.message || '读取通知偏好失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setDefaultProject(projects, setForm); }, [projects]);
  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  return {
    disablePreference: useDisablePreference(load, setError, setMutatingId),
    error,
    form,
    formError,
    handleSubmit: useCreatePreference(form, load, setForm, setFormError, setSubmitting),
    load,
    loading,
    mutatingId,
    preferences,
    projects,
    submitting,
    updateField,
  };
}

function useCreatePreference(form, load, setForm, setFormError, setSubmitting) {
  return async (event) => {
    event.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      await api.createPiGuardianPreference(buildCreatePayload(form));
      await load();
      setForm(initialForm(form.projectId));
    } catch (err) {
      setFormError(err.message || '创建通知偏好失败');
    } finally {
      setSubmitting(false);
    }
  };
}

function useDisablePreference(load, setError, setMutatingId) {
  return async (preference) => {
    setError('');
    setMutatingId(preference.id);
    try {
      await api.disablePiGuardianPreference(preference.id);
      await load();
    } catch (err) {
      setError(err.message || '禁用通知偏好失败');
    } finally {
      setMutatingId('');
    }
  };
}

function PreferenceHeader({ loading, onRefresh }) {
  return (
    <div className="pi-guardian-preferences-header">
      <div>
        <h2><BellOff size={18} /> 通知偏好</h2>
        <p>查看当前 PI Guardian notification preference，并提供最小创建/禁用入口；复杂设置页留到后续阶段。</p>
      </div>
      <button className="pi-command-refresh" disabled={loading} onClick={onRefresh} type="button">
        {loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />}
        刷新
      </button>
    </div>
  );
}

function PreferenceForm({ state }) {
  return (
    <form className="pi-guardian-preferences-form" onSubmit={state.handleSubmit}>
      {state.formError && <InlineError>{state.formError}</InlineError>}
      <div className="pi-guardian-preferences-fields">
        <label>范围<select className="form-control" value={state.form.scope} onChange={event => state.updateField('scope', event.target.value)}>
          <option value="project">项目</option>
          <option value="global">全局</option>
        </select></label>
        <label>项目<select className="form-control" disabled={state.form.scope === 'global'} required={state.form.scope === 'project'} value={state.form.projectId} onChange={event => state.updateField('projectId', event.target.value)}>
          <option value="">选择项目</option>
          {state.projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
        </select></label>
        <label>Mode<select className="form-control" value={state.form.mode} onChange={event => state.updateField('mode', event.target.value)}>
          <option value="quiet">quiet</option>
          <option value="digest">digest</option>
          <option value="normal">normal</option>
          <option value="verbose">verbose</option>
        </select></label>
        <label>TTL 分钟<input className="form-control" min="1" placeholder="480" type="number" value={state.form.ttlMinutes} onChange={event => state.updateField('ttlMinutes', event.target.value)} /></label>
        <label>Expires at<input className="form-control" type="datetime-local" value={state.form.expiresAt} onChange={event => state.updateField('expiresAt', event.target.value)} /></label>
        <label className="pi-guardian-preferences-wide">Notify on<input className="form-control" value={state.form.notifyOn} onChange={event => state.updateField('notifyOn', event.target.value)} /></label>
      </div>
      <button className="btn btn-primary" disabled={state.submitting} type="submit"><Plus size={14} /> {state.submitting ? '创建中…' : '创建偏好'}</button>
    </form>
  );
}

function PreferenceList({ loading, mutatingId, onDisable, preferences }) {
  if (loading && preferences.length === 0) return <div className="pi-guardian-preferences-empty"><Loader2 size={14} className="spin-animation" /> 正在加载通知偏好…</div>;
  if (preferences.length === 0) return <div className="pi-guardian-preferences-empty">暂无 active 通知偏好。</div>;
  return (
    <div className="pi-guardian-preferences-list">
      {preferences.map(preference => (
        <PreferenceRow key={preference.id} mutating={mutatingId === preference.id} onDisable={onDisable} preference={preference} />
      ))}
    </div>
  );
}

function PreferenceRow({ mutating, onDisable, preference }) {
  return (
    <article className="pi-guardian-preferences-row">
      <div className="pi-guardian-preferences-main">
        <div className="pi-guardian-preferences-title">
          <strong>{preference.mode || 'normal'} · {scopeLabel(preference)}</strong>
          {preference.admin_enforced && <span className="status-badge blocked"><ShieldCheck size={12} /> admin_enforced</span>}
        </div>
        <PreferenceMeta label="scope" value={scopeValue(preference)} />
        <PreferenceMeta label="expires_at" value={formatTime(preference.expires_at) || 'none'} />
        <PreferenceMeta label="notify_on" value={listText(preference.notify_on)} />
        <PreferenceMeta label="effective_after" value={effectiveAfter(preference)} />
        <PreferenceMeta label="admin_enforced" value={String(Boolean(preference.admin_enforced))} />
      </div>
      <button className="btn btn-secondary" disabled={mutating || preference.admin_enforced} onClick={() => onDisable(preference)} type="button">
        {mutating ? <Loader2 size={14} className="spin-animation" /> : <BellOff size={14} />}
        禁用
      </button>
    </article>
  );
}

function PreferenceMeta({ label, value }) {
  return <div className="pi-guardian-preferences-meta"><span>{label}</span><code>{value}</code></div>;
}

function buildCreatePayload(form) {
  const scope = form.scope;
  const ttlMinutes = Number(form.ttlMinutes || 0);
  const expiresAt = isoFromLocal(form.expiresAt);
  const payload = {
    mode: form.mode,
    notify_on: parseTokens(form.notifyOn),
    scope,
    source_message_id: 'command-center',
    temporary: Boolean(expiresAt || ttlMinutes),
  };
  if (scope === 'project') payload.project_id = requiredText(form.projectId, '请选择项目');
  if (expiresAt) payload.expires_at = expiresAt;
  else if (ttlMinutes > 0) payload.ttl_minutes = ttlMinutes;
  return payload;
}

function setDefaultProject(projects, setForm) {
  const firstProject = Array.isArray(projects) ? projects[0]?.id || '' : '';
  if (!firstProject) return;
  setForm(prev => (prev.projectId ? prev : { ...prev, projectId: firstProject }));
}

function parseTokens(value) {
  return value.split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
}

function requiredText(value, message) {
  const text = String(value || '').trim();
  if (!text) throw new Error(message);
  return text;
}

function isoFromLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Expires at 不是合法时间');
  return date.toISOString();
}

function scopeLabel(preference) {
  if (preference.run_group_id) return `run_group ${preference.run_group_id}`;
  if (preference.conversation_id) return `conversation ${preference.conversation_id}`;
  if (preference.project_id) return `project ${preference.project_id}`;
  return 'global';
}

function scopeValue(preference) {
  return `${preference.scope || 'global'}:${preference.run_group_id || preference.conversation_id || preference.project_id || 'default'}`;
}

function effectiveAfter(preference) {
  const effective = preference.effective_after || {};
  const sequence = effective.sequence ?? preference.effective_after_sequence ?? 0;
  const time = effective.time || preference.effective_after_time || '';
  return `seq=${sequence}${time ? ` · ${formatTime(time)}` : ''}`;
}

function listText(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'default';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function InlineError({ children }) {
  return <div className="pi-guardian-preferences-error" role="alert">{children}</div>;
}
