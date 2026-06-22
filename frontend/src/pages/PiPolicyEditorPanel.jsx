import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { COMMAND_CENTER_TERMS, modeLabel } from './piCommandCenterTerms';
import './PiPolicyEditorPanel.css';

const DEFAULT_ACTIONS = ['issue.enqueue', 'issue.state_repair', 'needs_user.escalate', 'session.read_summary'];
const DEFAULT_SUPERVISOR_ACTIONS = ['session.resume_followup'];
const WEEKDAYS = [
  ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun'],
];
const DEFAULT_MODES = ['manual', 'attended', 'delegated', 'autonomous'];
const SUPERVISOR_MODES = ['off', 'watchdog', 'propose_only', 'assisted', 'autonomous'];

export default function PiPolicyEditorPanel({ onChanged }) {
  const state = usePolicyEditorState(onChanged);
  return (
    <section className="pi-command-module pi-policy-panel" aria-label="项目执行策略编辑器">
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
      setState(prev => ({ ...prev, error: err.message || '读取执行策略失败', loading: false }));
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
        <h2><ShieldCheck size={18} /> 执行策略</h2>
        <p>
          编辑项目默认执行模式、工作时间、允许动作、技能与 {COMMAND_CENTER_TERMS.mcp} 允许列表；
          保存后写入项目 {COMMAND_CENTER_TERMS.policy}。
        </p>
      </div>
      <button className="pi-command-refresh" disabled={loading} onClick={onRefresh} type="button">
        {loading ? <Loader2 size={14} className="spin-animation" /> : <RefreshCw size={14} />} 刷新
      </button>
    </div>
  );
}

function PolicyForm({ state }) {
  const suggestions = useMemo(() => suggestionGroups(state.registries), [state.registries]);
  return (
    <form className="pi-policy-form" onSubmit={state.savePolicy}>
      {state.formError && <InlineError>{state.formError}</InlineError>}
      <div className="pi-policy-grid pi-policy-primary-fields">
        <ProjectSelect projects={state.projects} value={state.form.projectId} onChange={state.updateField} />
        <Field label="默认执行模式"><select className="form-control" value={state.form.defaultMode} onChange={e => state.updateField('defaultMode', e.target.value)}>
          {DEFAULT_MODES.map(mode => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}
        </select></Field>
        <Field label="时区"><input className="form-control" value={state.form.timezone} onChange={e => state.updateField('timezone', e.target.value)} /></Field>
        <Field label="工作日"><input className="form-control" placeholder="1,2,3,4,5" value={state.form.weekdays} onChange={e => state.updateField('weekdays', e.target.value)} /></Field>
        <Field label="工作开始时间"><input className="form-control" type="time" value={state.form.workingStart} onChange={e => state.updateField('workingStart', e.target.value)} /></Field>
        <Field label="工作结束时间"><input className="form-control" type="time" value={state.form.workingEnd} onChange={e => state.updateField('workingEnd', e.target.value)} /></Field>
      </div>
      <details className="pi-policy-advanced">
        <summary>
          <span>允许列表与工具边界</span>
          <small>这些高级项会影响 PI 能调用的动作、技能和 MCP 工具能力。</small>
        </summary>
        <div className="pi-policy-grid pi-policy-allowlists">
          <AllowlistField formKey="allowedActions" label="允许动作" suggestions={suggestions.actions} state={state} />
          <Field label="Supervisor 模式"><select className="form-control" value={state.form.supervisorMode} onChange={e => state.updateField('supervisorMode', e.target.value)}>
            {SUPERVISOR_MODES.map(mode => <option key={mode} value={mode}>{supervisorModeLabel(mode)}</option>)}
          </select></Field>
          <AllowlistField formKey="allowedSupervisorActions" label="允许自动恢复动作" suggestions={suggestions.supervisorActions} state={state} />
          <AllowlistField formKey="allowedSkills" label="允许技能" suggestions={suggestions.skills} state={state} />
          <AllowlistField formKey="allowedMcp" label="允许的 MCP 工具能力" suggestions={suggestions.mcp} state={state} />
        </div>
      </details>
      <p className="pi-policy-help">
        允许列表支持逗号或换行分隔；非法动作、技能或 MCP 工具能力会以内联错误提示，不会保存。
      </p>
      <div className="pi-policy-actions">
        <span className="pi-policy-muted">{state.policy?.updated_at ? `上次保存：${formatTime(state.policy.updated_at)}` : '尚未保存执行策略'}</span>
        <div className="pi-policy-action-buttons">
          <button className="btn btn-secondary" disabled={state.saving} onClick={state.resetToLoadedPolicy} type="button"><RotateCcw size={14} /> 重置</button>
          <button className="btn btn-primary" disabled={state.saving || !state.form.projectId} type="submit">
            {state.saving ? <Loader2 size={14} className="spin-animation" /> : <Save size={14} />} 保存策略
          </button>
        </div>
      </div>
    </form>
  );
}

function ProjectSelect({ onChange, projects, value }) {
  return <Field label="项目"><select className="form-control" required value={value} onChange={e => onChange('projectId', e.target.value)}>
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
    setState(prev => ({ ...prev, notice: '执行策略已保存', saving: false }));
  } catch (err) {
    setState(prev => ({ ...prev, formError: err.message || '保存执行策略失败', saving: false }));
  }
}

function validatePolicyForm(form) {
  if (!form.projectId.trim()) return '请选择项目';
  if (!form.timezone.trim()) return '时区不能为空';
  if (parseWeekdays(form.weekdays).length === 0) return '工作日至少选择一天';
  if (form.workingStart && form.workingEnd && form.workingStart >= form.workingEnd) return '工作结束时间必须晚于工作开始时间';
  return '';
}

function buildPolicyPayload(form) {
  return {
    allowed_actions: parseCSV(form.allowedActions),
    allowed_mcp_capabilities: parseCSV(form.allowedMcp),
    allowed_skill_intents: parseCSV(form.allowedSkills),
    allowed_supervisor_actions: parseCSV(form.allowedSupervisorActions),
    default_mode: form.defaultMode,
    supervisor_mode: form.supervisorMode,
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
    allowedSupervisorActions: DEFAULT_SUPERVISOR_ACTIONS.join(', '),
    defaultMode: 'manual',
    projectId,
    supervisorMode: 'autonomous',
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
    allowedSupervisorActions: parseArray(policy.allowed_supervisor_actions_json).join(', '),
    defaultMode: policy.default_mode || 'manual',
    projectId: policy.project_id || fallbackProjectId,
    supervisorMode: policy.supervisor_mode || 'autonomous',
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
    supervisorActions: ['session.resume_followup', 'issue.retry_after', 'issue.retry', 'needs_user.escalate'],
  };
}

function supervisorModeLabel(mode) {
  const labels = {
    assisted: 'assisted（需审批）',
    autonomous: 'autonomous（允许列表内自动恢复）',
    off: 'off（关闭）',
    propose_only: 'propose_only（只建议）',
    watchdog: 'watchdog（只记录信号）',
  };
  return labels[mode] || mode;
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
