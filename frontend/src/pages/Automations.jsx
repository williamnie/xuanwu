import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Bot, CalendarClock, CheckCircle2, ChevronRight, CirclePause, Clock3,
  FileClock, Filter, Pencil, Play, Plus, RefreshCw, Save, Search, X
} from 'lucide-react';
import { nativeAutomationsApi } from '../api/nativeAutomations.js';
import { eventsApi } from '../api/events.js';
import { PRODUCT_NAV_LABELS } from '../brand.js';
import { selectProjects, useDataStore } from '../store/dataStore.js';
import { message } from '../store/toastStore.js';
import {
  AUTOMATION_STATUSES, AUTOMATION_TRIGGERS, automationCreatePayload, automationForm,
  automationUpdatePayload, emptyAutomationForm, filterAutomations, triggerChanged, triggerUpdatePayload
} from './automationsModel.js';
import './Automations.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function Automations() {
  const projects = useDataStore(selectProjects);
  const [filters, setFilters] = useState({ projectId: '', query: '', status: '', triggerType: '' });
  const [state, setState] = useState({ authority: null, error: '', items: [], loading: true });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailState, setDetailState] = useState({ error: '', loading: false });
  const [editor, setEditor] = useState(null);
  const [submitting, setSubmitting] = useState('');
  const { projectId, status, triggerType } = filters;

  const loadList = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setState(previous => ({ ...previous, loading: true }));
    try {
      const result = await nativeAutomationsApi.list({ projectId, status, triggerType });
      setState({ authority: result.authority || null, error: '', items: result.automations || [], loading: false });
      setSelectedId(current => current && (result.automations || []).some(item => item.id === current)
        ? current : result.automations?.[0]?.id || '');
    } catch (error) {
      setState(previous => ({ ...previous, error: error.message || '读取 Automations 失败', loading: false }));
    }
  }, [projectId, status, triggerType]);

  const loadDetail = useCallback(async (id, { silent = false } = {}) => {
    if (!id) { setDetail(null); return; }
    if (!silent) setDetailState({ error: '', loading: true });
    try {
      const result = await nativeAutomationsApi.detail(id);
      setDetail(result);
      setDetailState({ error: '', loading: false });
    } catch (error) {
      setDetailState({ error: error.message || '读取 Automation 详情失败', loading: false });
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadDetail(selectedId); }, [loadDetail, selectedId]);
  useEffect(() => {
    const refresh = () => { loadList({ silent: true }); if (selectedId) loadDetail(selectedId, { silent: true }); };
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const unsubscribe = eventsApi.subscribeToEvents(event => {
      if (String(event?.type || '').startsWith('automation.')) refresh();
    });
    return () => { window.clearInterval(interval); unsubscribe(); };
  }, [loadDetail, loadList, selectedId]);

  const visibleItems = useMemo(() => filterAutomations(state.items, filters.query), [filters.query, state.items]);
  const startCreate = () => setEditor({ form: emptyAutomationForm(filters.projectId || projects[0]?.id || ''), mode: 'create' });
  const startEdit = () => detail && setEditor({ form: automationForm(detail), mode: 'edit' });

  const save = async () => {
    if (!editor || submitting) return;
    setSubmitting('save');
    try {
      let savedId = detail?.automation?.id || '';
      if (editor.mode === 'create') {
        const result = await nativeAutomationsApi.create(automationCreatePayload(editor.form));
        savedId = result.automation.id;
        setSelectedId(result.automation.id);
        message.success('Automation 已创建并写入审计');
      } else {
        let result = await nativeAutomationsApi.update(detail.automation.id, automationUpdatePayload(editor.form, detail.automation.revision));
        if (triggerChanged(editor.form, detail)) {
          result = await nativeAutomationsApi.updateTrigger(detail.automation.id, triggerUpdatePayload(editor.form, result.automation.revision));
        }
        setSelectedId(result.automation.id);
        message.success('Automation 已更新并写入审计');
      }
      setEditor(null);
      await loadList({ silent: true });
      await loadDetail(savedId, { silent: true });
    } catch (error) {
      message.error(error.message || '保存 Automation 失败');
    } finally { setSubmitting(''); }
  };

  const control = async action => {
    if (!detail?.automation || submitting) return;
    setSubmitting(action);
    try {
      const current = detail.automation;
      if (action === 'run') {
        await nativeAutomationsApi.runNow(current.id, { expected_revision: current.revision });
        message.success('Run now 已排队；状态会自动刷新');
      } else {
        const status = current.status === 'active' ? 'paused' : 'active';
        await nativeAutomationsApi.setStatus(current.id, { expected_revision: current.revision, status });
        message.success(status === 'paused' ? 'Automation 已暂停' : 'Automation 已启用');
      }
      await loadList({ silent: true });
      await loadDetail(current.id, { silent: true });
    } catch (error) {
      message.error(error.message || 'Automation 操作失败');
    } finally { setSubmitting(''); }
  };

  return <div className="automations-page animate-fade-in">
    <header className="automations-hero">
      <div><span className="automations-kicker"><Bot size={15} /> Always-on control plane</span>
        <h1>{PRODUCT_NAV_LABELS.automations}</h1>
        <p>统一管理 Cron、Heartbeat、Watch 与 Standing Order 的定义、触发器、执行历史和审计。</p>
      </div>
      <div className="automations-hero-actions">
        <button className="btn btn-secondary" disabled={state.loading} onClick={() => loadList()} type="button"><RefreshCw className={state.loading ? 'is-spinning' : ''} size={15} />刷新</button>
        <button className="btn btn-primary" onClick={startCreate} type="button"><Plus size={15} />新建 Automation</button>
      </div>
    </header>

    <AutomationFilters filters={filters} projects={projects} setFilters={setFilters} />
    <div className="automations-workspace">
      <AutomationList error={state.error} items={visibleItems} loading={state.loading} onRetry={() => loadList()} onSelect={setSelectedId} selectedId={selectedId} />
      <AutomationDetail detail={detail} error={detailState.error} loading={detailState.loading} onControl={control} onEdit={startEdit} onRetry={() => loadDetail(selectedId)} submitting={submitting} />
    </div>
    {editor ? <AutomationEditor editor={editor} onCancel={() => setEditor(null)} onChange={form => setEditor(previous => ({ ...previous, form }))} onSave={save} projects={projects} submitting={submitting === 'save'} /> : null}
  </div>;
}

function AutomationFilters({ filters, projects, setFilters }) {
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  return <section className="automations-filters" aria-label="Automation filters">
    <label className="automation-search"><Search size={14} /><input aria-label="搜索 Automation" onChange={event => update('query', event.target.value)} placeholder="搜索名称、ID、Workflow…" value={filters.query} /></label>
    <label><Filter size={13} /><select aria-label="状态筛选" onChange={event => update('status', event.target.value)} value={filters.status}><option value="">全部状态</option>{AUTOMATION_STATUSES.map(item => <option key={item}>{item}</option>)}</select></label>
    <label><CalendarClock size={13} /><select aria-label="触发器筛选" onChange={event => update('triggerType', event.target.value)} value={filters.triggerType}><option value="">全部触发器</option>{AUTOMATION_TRIGGERS.map(item => <option key={item}>{item}</option>)}</select></label>
    <label><Bot size={13} /><select aria-label="项目筛选" onChange={event => update('projectId', event.target.value)} value={filters.projectId}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}</select></label>
  </section>;
}

function AutomationList({ error, items, loading, onRetry, onSelect, selectedId }) {
  return <aside className="automation-list-panel">
    <div className="automation-panel-title"><span>Definitions</span><strong>{items.length}</strong></div>
    {error ? <AutomationState error={error} onRetry={onRetry} /> : loading && items.length === 0 ? <AutomationState loading /> : items.length === 0 ? <AutomationState /> : (
      <div className="automation-list">{items.map(item => <button className={`automation-row ${selectedId === item.id ? 'active' : ''}`} key={item.id} onClick={() => onSelect(item.id)} type="button">
        <span className={`automation-status-dot ${item.status}`} />
        <span><strong>{item.name}</strong><small>{item.trigger?.type || 'manual'} · {item.mode}</small><em>{item.owner?.project_id || 'control plane'}</em></span>
        <ChevronRight size={15} />
      </button>)}</div>
    )}
  </aside>;
}

function AutomationDetail({ detail, error, loading, onControl, onEdit, onRetry, submitting }) {
  if (error) return <main className="automation-detail-panel"><AutomationState error={error} onRetry={onRetry} /></main>;
  if (loading && !detail) return <main className="automation-detail-panel"><AutomationState loading /></main>;
  if (!detail?.automation) return <main className="automation-detail-panel"><AutomationState detail /></main>;
  const automation = detail.automation;
  const trigger = detail.trigger;
  return <main className="automation-detail-panel">
    <header className="automation-detail-header"><div><div className="automation-detail-id">{automation.id}</div><h2>{automation.name}</h2><p>{automation.workflow_ref}</p></div>
      <div className="automation-detail-actions">
        <button className="btn btn-secondary" onClick={onEdit} type="button"><Pencil size={14} />编辑</button>
        {automation.status !== 'archived' && automation.status !== 'draft' ? <button className="btn btn-secondary" disabled={Boolean(submitting)} onClick={() => onControl('status')} type="button">{automation.status === 'active' ? <CirclePause size={14} /> : <Play size={14} />}{automation.status === 'active' ? '暂停' : '启用'}</button> : null}
        <button className="btn btn-primary" disabled={automation.status !== 'active' || Boolean(submitting)} onClick={() => onControl('run')} type="button"><Play size={14} />{submitting === 'run' ? '排队中…' : 'Run now'}</button>
      </div>
    </header>
    <div className="automation-facts">
      <Fact icon={Activity} label="Status" value={automation.status} /><Fact icon={CalendarClock} label="Trigger" value={triggerSummary(trigger)} />
      <Fact icon={Clock3} label="Next run" value={formatTime(automation.next_run_at)} /><Fact icon={CheckCircle2} label="Mode" value={automation.mode} />
      <Fact icon={Bot} label="Scope" value={automation.owner?.project_id || 'control plane'} /><Fact icon={FileClock} label="Revision" value={`r${automation.revision} · trigger v${automation.active_trigger_version}`} />
    </div>
    <History runs={detail.runs || []} events={detail.events || []} />
  </main>;
}

function Fact({ icon: Icon, label, value }) { return <div className="automation-fact"><Icon size={15} /><span><small>{label}</small><strong>{value || '—'}</strong></span></div>; }

function History({ events, runs }) {
  const rows = [
    ...runs.map(run => ({ detail: run.summary?.detail || run.idempotency_key, id: run.run_id, status: run.status, time: run.created_at, type: 'run' })),
    ...events.map(event => ({ detail: event.reason, id: event.event_id, status: event.gate_decision, time: event.occurred_at, type: event.event_type }))
  ].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return <section className="automation-history"><div className="automation-history-title"><FileClock size={16} /><h3>History & audit</h3><span>{rows.length}</span></div>
    {rows.length === 0 ? <div className="automation-history-empty">尚无执行或变更历史。Run now 后会在这里显示排队和结果。</div> : <div className="automation-timeline">{rows.map(row => <article key={row.id}><span className={`history-mark ${row.status}`} /><div><strong>{row.type}</strong><p>{row.detail || 'No detail'}</p><small>{formatTime(row.time)} · {row.status}</small></div></article>)}</div>}
  </section>;
}

function AutomationEditor({ editor, onCancel, onChange, onSave, projects, submitting }) {
  const form = editor.form;
  const update = (key, value) => onChange({ ...form, [key]: value });
  return <div className="automation-editor-backdrop" role="presentation"><section aria-label="Automation editor" aria-modal="true" className="automation-editor" role="dialog">
    <header><div><span>{editor.mode === 'create' ? 'Create definition' : 'Edit definition'}</span><h2>{editor.mode === 'create' ? '新建 Automation' : form.name}</h2></div><button aria-label="关闭编辑器" onClick={onCancel} type="button"><X size={18} /></button></header>
    <div className="automation-form-grid">
      <FormField label="Name"><input onChange={event => update('name', event.target.value)} value={form.name} /></FormField>
      <FormField label="ID"><input disabled={editor.mode === 'edit'} onChange={event => update('id', event.target.value)} placeholder="daily-review" value={form.id} /></FormField>
      <FormField label="Project"><select disabled={editor.mode === 'edit'} onChange={event => { const id = event.target.value; onChange({ ...form, project_id: id, permission_policy_ref: id ? `project-policy:${id}` : 'control-plane-policy:local' }); }} value={form.project_id}><option value="">Control plane</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}</select></FormField>
      <FormField label="Status"><select disabled={editor.mode === 'edit'} onChange={event => update('status', event.target.value)} value={form.status}>{AUTOMATION_STATUSES.map(item => <option key={item}>{item}</option>)}</select></FormField>
      <FormField label="Workflow ref"><input onChange={event => update('workflow_ref', event.target.value)} value={form.workflow_ref} /></FormField>
      <FormField label="Mode"><select onChange={event => update('mode', event.target.value)} value={form.mode}><option value="observe">observe</option><option value="propose">propose</option><option value="execute_allowed">execute_allowed</option></select></FormField>
      <FormField label="Permission policy"><input onChange={event => update('permission_policy_ref', event.target.value)} value={form.permission_policy_ref} /></FormField>
      <FormField label="Trigger"><select onChange={event => update('trigger_type', event.target.value)} value={form.trigger_type}>{AUTOMATION_TRIGGERS.map(item => <option key={item}>{item}</option>)}</select></FormField>
      {form.trigger_type === 'cron' ? <><FormField label="Cron expression"><input onChange={event => update('trigger_expression', event.target.value)} value={form.trigger_expression} /></FormField><FormField label="IANA timezone"><input onChange={event => update('trigger_timezone', event.target.value)} value={form.trigger_timezone} /></FormField></> : null}
      {form.trigger_type === 'continuous' ? <FormField label="Poll interval (seconds)"><input min="1" onChange={event => update('trigger_interval', event.target.value)} type="number" value={form.trigger_interval} /></FormField> : null}
      {form.trigger_type === 'webhook' ? <FormField label="Event type"><input onChange={event => update('trigger_event_type', event.target.value)} value={form.trigger_event_type} /></FormField> : null}
    </div>
    <div className="automation-editor-note"><AlertTriangle size={14} />所有创建、编辑、状态和 Run now 操作均通过 authenticated user gate，并写入 Automation 审计历史。</div>
    <footer><button className="btn btn-secondary" onClick={onCancel} type="button">取消</button><button className="btn btn-primary" disabled={submitting || !form.name.trim() || !form.workflow_ref.trim()} onClick={onSave} type="button"><Save size={14} />{submitting ? '保存中…' : '保存'}</button></footer>
  </section></div>;
}

function FormField({ children, label }) { return <label className="automation-form-field"><span>{label}</span>{children}</label>; }

function AutomationState({ detail = false, error = '', loading = false, onRetry }) {
  if (error) return <div className="automation-state error"><AlertTriangle size={22} /><strong>无法读取 Automations</strong><p>{error}</p><button className="btn btn-secondary" onClick={onRetry} type="button">重试</button></div>;
  if (loading) return <div className="automation-state"><RefreshCw className="is-spinning" size={22} /><strong>正在同步 Automation authority…</strong></div>;
  return <div className="automation-state"><Bot size={24} /><strong>{detail ? '选择一个 Automation 查看详情' : '暂无匹配的 Automation'}</strong><p>{detail ? '详情包含 trigger、下一次运行、历史和审计。' : '调整筛选条件，或新建第一个 always-on Automation。'}</p></div>;
}

function triggerSummary(trigger) {
  if (!trigger) return '—';
  if (trigger.type === 'cron') return `${trigger.config?.expression} · ${trigger.config?.timezone}`;
  if (trigger.type === 'continuous') return `every ${trigger.config?.poll_interval_seconds}s`;
  if (trigger.type === 'webhook') return trigger.config?.event_type || 'webhook';
  return 'manual';
}

function formatTime(value) { return value ? new Date(value).toLocaleString() : '—'; }
