import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import './PiPolicyEditorPanel.css';

const DEFAULT_ACTIONS = ['issue.enqueue', 'issue.state_repair', 'needs_user.escalate', 'session.read_summary'];
const WEEKDAYS = [
  ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun'],
];

export default function PiPolicyEditorPanel({ onChanged }) {
  const state = usePolicyEditorState(onChanged);
  return (
    <section className="pi-command-module pi-policy-panel" aria-label="Project policy editor">
      <PolicyHeader loading={state.loading} onRefresh={state.load} />
      {state.error && <InlineError>{state.error}</InlineError>}
      {state.notice && <div className="pi-policy-success">{state.notice}</div>}
      <PolicyForm state={state} />
    </section>
  );
}

function usePolicyEditorState(onChanged) {
  const [state, setState] = useState({
    error: '', form: blankForm(), loading: true, notice: '', policy: null,
    projects: [], registries: emptyRegistries(), saving: false,
  });
  const projectId = state.form.projectId;
  const load = useCallback(async () => {
    setState(prev => ({ ...prev, error: '', loading: true, notice: '' }));
    try {
      const [projects, skills, mcp] = await Promise.all([
        api.getProjects(), api.getPiSkills(), api.getPiMcpCapabilities(),
      ]);
      const nextProjects = Array.isArray(projects) ? projects : [];
      const nextProjectId = projectId || nextProjects[0]?.id || '';
      const policy = nextProjectId ? await api.getProjectPiPolicy(nextProjectId) : null;
      setState(prev => ({
        ...prev,
        form: policy ? formFromPolicy(policy) : blankForm(nextProjectId),
        loading: false,
        policy,
        projects: nextProjects,
        registries: registriesFromApi(skills, mcp),
      }));
    } catch (err) {
      setState(prev => ({ ...prev, error: err.message || '读取 policy 失败', loading: false }));
    }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  const updateField = (field, value) => setState(prev => ({ ...prev, form: { ...prev.form, [field]: value }, notice: '' }));
  return {
    ...state,
    load,
    resetToLoadedPolicy: () => setState(prev => ({ ...prev, error: '', form: formFromPolicy(prev.policy, prev.form.projectId), notice: '' })),
    savePolicy: async (event) => savePolicy(event, state.form, setState, load, onChanged),
    updateField,
  };
}

function PolicyHeader({ loading, onRefresh }) {
  return (
    <div className="pi-policy-header">
      <div>
        <h2><ShieldCheck size={18} /> Policy</h2>
        <p>编辑项目默认 mode、working hours、allowed actions、skill/MCP allowlist；保存后写入项目 policy API。</p>
      </div>
      <button className="pi-command-refresh" disabled={loading} onClick={onRefresh} type="button">
        {loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} Refresh
      </button>
    </div>
  );
}

function PolicyForm({ state }) {
  const suggestions = useMemo(() => suggestionGroups(state.registries), [state.registries]);
  return (
    <form className="pi-policy-form" onSubmit={state.savePolicy}>
      {state.formError && <InlineError>{state.formError}</InlineError>}
      <div className="pi-policy-grid">
        <ProjectSelect projects={state.projects} value={state.form.projectId} onChange={state.updateField} />
        <Field label="Default mode"><select className="form-control" value={state.form.defaultMode} onChange={e => state.updateField('defaultMode', e.target.value)}>
          {['manual', 'attended', 'delegated', 'autonomous'].map(mode => <option key={mode} value={mode}>{mode}</option>)}
        </select></Field>
        <Field label="Timezone"><input className="form-control" value={state.form.timezone} onChange={e => state.updateField('timezone', e.target.value)} /></Field>
        <Field label="Weekdays"><input className="form-control" placeholder="1,2,3,4,5" value={state.form.weekdays} onChange={e => state.updateField('weekdays', e.target.value)} /></Field>
        <Field label="Working start"><input className="form-control" type="time" value={state.form.workingStart} onChange={e => state.updateField('workingStart', e.target.value)} /></Field>
        <Field label="Working end"><input className="form-control" type="time" value={state.form.workingEnd} onChange={e => state.updateField('workingEnd', e.target.value)} /></Field>
        <AllowlistField formKey="allowedActions" label="Allowed actions" suggestions={suggestions.actions} state={state} />
        <AllowlistField formKey="allowedSkills" label="Allowed skills" suggestions={suggestions.skills} state={state} />
        <AllowlistField formKey="allowedMcp" label="Allowed MCP capabilities" suggestions={suggestions.mcp} state={state} />
      </div>
      <p className="pi-policy-help">列表支持逗号或换行分隔；非法 action / skill / MCP capability 会显示 inline error，不会保存。</p>
      <div className="pi-policy-actions">
        <span className="pi-policy-muted">{state.policy?.updated_at ? `Last saved ${formatTime(state.policy.updated_at)}` : 'Policy not persisted yet'}</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" disabled={state.saving} onClick={state.resetToLoadedPolicy} type="button"><RotateCcw size={14} /> Reset</button>
          <button className="btn btn-primary" disabled={state.saving || !state.form.projectId} type="submit">
            {state.saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} Save policy
          </button>
        </div>
      </div>
    </form>
  );
}

function ProjectSelect({ onChange, projects, value }) {
  return <Field label="Project"><select className="form-control" required value={value} onChange={e => onChange('projectId', e.target.value)}>
    <option value="">选择项目</option>
    {projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}
  </select></Field>;
}

function AllowlistField({ formKey, label, state, suggestions }) {
  return (
    <Field className="pi-policy-wide" label={label}>
      <textarea className="form-control" rows={3} value={state.form[formKey]} onChange={e => state.updateField(formKey, e.target.value)} />
      <SuggestionChips onPick={(value) => state.updateField(formKey, appendCSV(state.form[formKey], value))} values={suggestions} />
    </Field>
  );
}

function SuggestionChips({ onPick, values }) {
  if (values.length === 0) return null;
  return <div className="pi-policy-suggestions">{values.slice(0, 6).map(value => (
    <button className="pi-policy-suggestion" key={value} onClick={() => onPick(value)} type="button">{value}</button>
  ))}</div>;
}

function Field({ children, className = '', label }) {
  return <label className={`pi-policy-field ${className}`.trim()}>{label}{children}</label>;
}

function InlineError({ children }) {
  return <div className="pi-policy-error" role="alert">{children}</div>;
}

async function savePolicy(event, form, setState, load, onChanged) {
  event.preventDefault();
  const formError = validatePolicyForm(form);
  if (formError) return setState(prev => ({ ...prev, formError, notice: '' }));
  setState(prev => ({ ...prev, error: '', formError: '', notice: '', saving: true }));
  try {
    await api.updateProjectPiPolicy(form.projectId, buildPolicyPayload(form));
    await load();
    onChanged?.();
    setState(prev => ({ ...prev, notice: 'Policy saved', saving: false }));
  } catch (err) {
    setState(prev => ({ ...prev, formError: err.message || '保存 policy 失败', saving: false }));
  }
}

function validatePolicyForm(form) {
  if (!form.projectId.trim()) return '请选择项目';
  if (!form.timezone.trim()) return 'Timezone 不能为空';
  if (parseWeekdays(form.weekdays).length === 0) return 'Weekdays 至少选择一天';
  if (form.workingStart && form.workingEnd && form.workingStart >= form.workingEnd) return 'Working end 必须晚于 Working start';
  return '';
}

function buildPolicyPayload(form) {
  return {
    allowed_actions: parseCSV(form.allowedActions),
    allowed_mcp_capabilities: parseCSV(form.allowedMcp),
    allowed_skill_intents: parseCSV(form.allowedSkills),
    default_mode: form.defaultMode,
    timezone: form.timezone.trim(),
    working_hours: {
      end: form.workingEnd,
      start: form.workingStart,
      weekdays: parseWeekdays(form.weekdays),
    },
  };
}

function blankForm(projectId = '') {
  return {
    allowedActions: DEFAULT_ACTIONS.join(', '),
    allowedMcp: '',
    allowedSkills: '',
    defaultMode: 'manual',
    projectId,
    timezone: 'UTC',
    weekdays: '1,2,3,4,5',
    workingEnd: '18:00',
    workingStart: '09:00',
  };
}

function formFromPolicy(policy, fallbackProjectId = '') {
  if (!policy) return blankForm(fallbackProjectId);
  const working = parseObject(policy.working_hours_json);
  return {
    allowedActions: parseArray(policy.allowed_actions_json).join(', '),
    allowedMcp: parseArray(policy.allowed_mcp_capabilities_json).join(', '),
    allowedSkills: parseArray(policy.allowed_skill_intents_json).join(', '),
    defaultMode: policy.default_mode || 'manual',
    projectId: policy.project_id || fallbackProjectId,
    timezone: policy.timezone || 'UTC',
    weekdays: arrayText(working.weekdays, '1,2,3,4,5'),
    workingEnd: typeof working.end === 'string' ? working.end : '18:00',
    workingStart: typeof working.start === 'string' ? working.start : '09:00',
  };
}

function registriesFromApi(skills, mcp) {
  return {
    mcp: Array.isArray(mcp?.capabilities) ? mcp.capabilities : [],
    skills: Array.isArray(skills?.skills) ? skills.skills : [],
  };
}

function suggestionGroups(registries) {
  return {
    actions: DEFAULT_ACTIONS,
    mcp: registries.mcp.map(item => item.id).filter(Boolean),
    skills: registries.skills.map(item => item.id).filter(Boolean),
  };
}

function emptyRegistries() {
  return { mcp: [], skills: [] };
}

function appendCSV(current, value) {
  return [...new Set([...parseCSV(current), value])].join(', ');
}

function parseCSV(value) {
  return String(value || '').split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
}

function parseWeekdays(value) {
  const allowed = new Set(WEEKDAYS.map(([id]) => id));
  return parseCSV(value).map(Number).filter(day => allowed.has(String(day)));
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function arrayText(value, fallback) {
  return Array.isArray(value) ? value.join(',') : fallback;
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
