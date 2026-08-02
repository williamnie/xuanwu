import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, AlertTriangle, Bot, CalendarClock, CheckCircle2, ChevronRight, CirclePause, Clock3,
  FileClock, Filter, Pencil, Play, Plus, RefreshCw, Save, Search, X
} from 'lucide-react';
import { nativeAutomationsApi } from '../api/nativeAutomations.js';
import { eventsApi } from '../api/events.js';
import { useI18n } from '../i18n/context.js';
import { selectProjects, useDataStore } from '../store/dataStore.js';
import { message } from '../store/toastStore.js';
import {
  AUTOMATION_STATUSES, AUTOMATION_TRIGGERS, automationCreatePayload, automationForm,
  automationUpdatePayload, emptyAutomationForm, filterAutomations, triggerChanged, triggerUpdatePayload
} from './automationsModel.js';
import './Automations.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function Automations() {
  const { t } = useI18n();
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
      setState(previous => ({ ...previous, error: error.message || t('automations.loadFailed'), loading: false }));
    }
  }, [projectId, status, t, triggerType]);

  const loadDetail = useCallback(async (id, { silent = false } = {}) => {
    if (!id) { setDetail(null); return; }
    if (!silent) setDetailState({ error: '', loading: true });
    try {
      const result = await nativeAutomationsApi.detail(id);
      setDetail(result);
      setDetailState({ error: '', loading: false });
    } catch (error) {
      setDetailState({ error: error.message || t('automations.detailLoadFailed'), loading: false });
    }
  }, [t]);

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
  const closeEditor = useCallback(() => setEditor(null), []);

  const save = async () => {
    if (!editor || submitting) return;
    setSubmitting('save');
    try {
      let savedId = detail?.automation?.id || '';
      if (editor.mode === 'create') {
        const result = await nativeAutomationsApi.create(automationCreatePayload(editor.form));
        savedId = result.automation.id;
        setSelectedId(result.automation.id);
        message.success(t('automations.created'));
      } else {
        let result = await nativeAutomationsApi.update(detail.automation.id, automationUpdatePayload(editor.form, detail.automation.revision));
        if (triggerChanged(editor.form, detail)) {
          result = await nativeAutomationsApi.updateTrigger(detail.automation.id, triggerUpdatePayload(editor.form, result.automation.revision));
        }
        setSelectedId(result.automation.id);
        message.success(t('automations.updated'));
      }
      setEditor(null);
      await loadList({ silent: true });
      await loadDetail(savedId, { silent: true });
    } catch (error) {
      message.error(error.message || t('automations.saveFailed'));
    } finally { setSubmitting(''); }
  };

  const control = async action => {
    if (!detail?.automation || submitting) return;
    setSubmitting(action);
    try {
      const current = detail.automation;
      if (action === 'run') {
        await nativeAutomationsApi.runNow(current.id, { expected_revision: current.revision });
        message.success(t('automations.runQueued'));
      } else {
        const status = current.status === 'active' ? 'paused' : 'active';
        await nativeAutomationsApi.setStatus(current.id, { expected_revision: current.revision, status });
        message.success(status === 'paused' ? t('automations.paused') : t('automations.activated'));
      }
      await loadList({ silent: true });
      await loadDetail(current.id, { silent: true });
    } catch (error) {
      message.error(error.message || t('automations.actionFailed'));
    } finally { setSubmitting(''); }
  };

  return <div className="automations-page animate-fade-in">
    <header className="automations-hero">
      <div><span className="automations-kicker"><Bot size={15} /> {t('automations.kicker')}</span>
        <h1>{t('nav.automations')}</h1>
        <p>{t('automations.description')}</p>
      </div>
      <div className="automations-hero-actions">
        <button className="btn btn-secondary" disabled={state.loading} onClick={() => loadList()} type="button"><RefreshCw className={state.loading ? 'is-spinning' : ''} size={15} />{t('automations.refresh')}</button>
        <button className="btn btn-primary" onClick={startCreate} type="button"><Plus size={15} />{t('automations.create')}</button>
      </div>
    </header>

    <AutomationFilters filters={filters} projects={projects} setFilters={setFilters} />
    <div className="automations-workspace">
      <AutomationList error={state.error} items={visibleItems} loading={state.loading} onRetry={() => loadList()} onSelect={setSelectedId} selectedId={selectedId} />
      <AutomationDetail detail={detail} error={detailState.error} loading={detailState.loading} onControl={control} onEdit={startEdit} onRetry={() => loadDetail(selectedId)} submitting={submitting} />
    </div>
    {editor ? <AutomationEditor editor={editor} onCancel={closeEditor} onChange={form => setEditor(previous => ({ ...previous, form }))} onSave={save} projects={projects} submitting={submitting === 'save'} /> : null}
  </div>;
}

function AutomationFilters({ filters, projects, setFilters }) {
  const { t } = useI18n();
  const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
  return <section className="automations-filters" aria-label={t('automations.filters')}>
    <label className="automation-search"><Search size={14} /><input aria-label={t('automations.search')} onChange={event => update('query', event.target.value)} placeholder={t('automations.searchPlaceholder')} value={filters.query} /></label>
    <label><Filter size={13} /><select aria-label={t('automations.statusFilter')} onChange={event => update('status', event.target.value)} value={filters.status}><option value="">{t('automations.allStatuses')}</option>{AUTOMATION_STATUSES.map(item => <option key={item} value={item}>{t(`automations.status.${item}`)}</option>)}</select></label>
    <label><CalendarClock size={13} /><select aria-label={t('automations.triggerFilter')} onChange={event => update('triggerType', event.target.value)} value={filters.triggerType}><option value="">{t('automations.allTriggers')}</option>{AUTOMATION_TRIGGERS.map(item => <option key={item} value={item}>{t(`automations.trigger.${item}`)}</option>)}</select></label>
    <label><Bot size={13} /><select aria-label={t('automations.projectFilter')} onChange={event => update('projectId', event.target.value)} value={filters.projectId}><option value="">{t('automations.allProjects')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}</select></label>
  </section>;
}

function AutomationList({ error, items, loading, onRetry, onSelect, selectedId }) {
  const { t } = useI18n();
  return <aside className="automation-list-panel">
    <div className="automation-panel-title"><span>{t('automations.definitions')}</span><strong>{items.length}</strong></div>
    {error ? <AutomationState error={error} onRetry={onRetry} /> : loading && items.length === 0 ? <AutomationState loading /> : items.length === 0 ? <AutomationState /> : (
      <div className="automation-list">{items.map(item => <button className={`automation-row ${selectedId === item.id ? 'active' : ''}`} key={item.id} onClick={() => onSelect(item.id)} type="button">
        <span className={`automation-status-dot ${item.status}`} />
        <span><strong>{item.name}</strong><small>{t(`automations.trigger.${item.trigger?.type || 'manual'}`)} · {t(`automations.mode.${item.mode}`)}</small><em>{item.owner?.project_id || t('automations.controlPlane')}</em></span>
        <ChevronRight size={15} />
      </button>)}</div>
    )}
  </aside>;
}

function AutomationDetail({ detail, error, loading, onControl, onEdit, onRetry, submitting }) {
  const { language, t } = useI18n();
  if (error) return <main className="automation-detail-panel"><AutomationState error={error} onRetry={onRetry} /></main>;
  if (loading && !detail) return <main className="automation-detail-panel"><AutomationState loading /></main>;
  if (!detail?.automation) return <main className="automation-detail-panel"><AutomationState detail /></main>;
  const automation = detail.automation;
  const trigger = detail.trigger;
  return <main className="automation-detail-panel">
    <header className="automation-detail-header"><div><div className="automation-detail-id">{automation.id}</div><h2>{automation.name}</h2><p>{automation.workflow_ref}</p></div>
      <div className="automation-detail-actions">
        <button className="btn btn-secondary" onClick={onEdit} type="button"><Pencil size={14} />{t('automations.edit')}</button>
        {automation.status !== 'archived' && automation.status !== 'draft' ? <button className="btn btn-secondary" disabled={Boolean(submitting)} onClick={() => onControl('status')} type="button">{automation.status === 'active' ? <CirclePause size={14} /> : <Play size={14} />}{automation.status === 'active' ? t('automations.pause') : t('automations.activate')}</button> : null}
        <button className="btn btn-primary" disabled={automation.status !== 'active' || Boolean(submitting)} onClick={() => onControl('run')} type="button"><Play size={14} />{submitting === 'run' ? t('automations.queueing') : t('automations.runNow')}</button>
      </div>
    </header>
    <div className="automation-facts">
      <Fact icon={Activity} label={t('automations.fact.status')} value={t(`automations.status.${automation.status}`)} /><Fact icon={CalendarClock} label={t('automations.fact.trigger')} value={triggerSummary(trigger, t)} />
      <Fact icon={Clock3} label={t('automations.fact.nextRun')} value={formatTime(automation.next_run_at, language)} /><Fact icon={CheckCircle2} label={t('automations.fact.mode')} value={t(`automations.mode.${automation.mode}`)} />
      <Fact icon={Bot} label={t('automations.fact.scope')} value={automation.owner?.project_id || t('automations.controlPlane')} /><Fact icon={FileClock} label={t('automations.fact.revision')} value={`r${automation.revision} · trigger v${automation.active_trigger_version}`} />
    </div>
    <History runs={detail.runs || []} events={detail.events || []} />
  </main>;
}

function Fact({ icon: Icon, label, value }) { return <div className="automation-fact"><Icon size={15} /><span><small>{label}</small><strong>{value || '—'}</strong></span></div>; }

function History({ events, runs }) {
  const { language, t } = useI18n();
  const rows = [
    ...runs.map(run => ({ detail: run.summary?.detail || run.idempotency_key, id: run.run_id, status: run.status, time: run.created_at, type: 'run' })),
    ...events.map(event => ({ detail: event.reason, id: event.event_id, status: event.gate_decision, time: event.occurred_at, type: event.event_type }))
  ].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return <section className="automation-history"><div className="automation-history-title"><FileClock size={16} /><h3>{t('automations.history')}</h3><span>{rows.length}</span></div>
    {rows.length === 0 ? <div className="automation-history-empty">{t('automations.historyEmpty')}</div> : <div className="automation-timeline">{rows.map(row => <article key={row.id}><span className={`history-mark ${row.status}`} /><div><strong>{row.type === 'run' ? t('automations.historyRun') : t('automations.historyEvent')}</strong><p>{row.detail || t('automations.noDetail')}</p><small>{formatTime(row.time, language)} · {row.status}</small></div></article>)}</div>}
  </section>;
}

function AutomationEditor({ editor, onCancel, onChange, onSave, projects, submitting }) {
  const { t } = useI18n();
  const form = editor.form;
  const update = (key, value) => onChange({ ...form, [key]: value });
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = event => { if (event.key === 'Escape') onCancel(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape); };
  }, [onCancel]);

  return createPortal(<div className="automation-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }} role="presentation"><section aria-label={t('automations.editorLabel')} aria-modal="true" className="automation-editor" role="dialog">
    <header><div><span>{editor.mode === 'create' ? t('automations.createDefinition') : t('automations.editDefinition')}</span><h2>{editor.mode === 'create' ? t('automations.create') : form.name}</h2><p>{t('automations.editorIntro')}</p></div><button aria-label={t('automations.closeEditor')} onClick={onCancel} type="button"><X size={18} /></button></header>
    <div className="automation-editor-body">
      <FormSection description={t('automations.basicDescription')} index="01" title={t('automations.basicTitle')}>
        <FormField hint={t('automations.field.nameHint')} label={t('automations.field.name')}><input autoFocus onChange={event => update('name', event.target.value)} placeholder={t('automations.field.namePlaceholder')} value={form.name} /></FormField>
        <FormField hint={t('automations.field.idHint')} label={t('automations.field.id')}><input disabled={editor.mode === 'edit'} onChange={event => update('id', event.target.value)} placeholder="daily-review" value={form.id} /></FormField>
        <FormField hint={t('automations.field.projectHint')} label={t('automations.field.project')}><select disabled={editor.mode === 'edit'} onChange={event => { const id = event.target.value; onChange({ ...form, project_id: id, permission_policy_ref: id ? `project-policy:${id}` : 'control-plane-policy:local' }); }} value={form.project_id}><option value="">{t('automations.controlPlane')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name || project.id}</option>)}</select></FormField>
        <FormField hint={t('automations.field.statusHint')} label={t('automations.field.status')}><select disabled={editor.mode === 'edit'} onChange={event => update('status', event.target.value)} value={form.status}>{AUTOMATION_STATUSES.map(item => <option key={item} value={item}>{t(`automations.status.${item}`)}</option>)}</select></FormField>
      </FormSection>

      <FormSection description={t('automations.executionDescription')} index="02" title={t('automations.executionTitle')}>
        <FormField hint={t('automations.field.workflowHint')} label={t('automations.field.workflow')} wide><input onChange={event => update('workflow_ref', event.target.value)} placeholder="workflow:investigate@1" value={form.workflow_ref} /></FormField>
        <FormField hint={t('automations.field.modeHint')} label={t('automations.field.mode')}><select onChange={event => update('mode', event.target.value)} value={form.mode}><option value="observe">{t('automations.modeOption.observe')}</option><option value="propose">{t('automations.modeOption.propose')}</option><option value="execute_allowed">{t('automations.modeOption.execute_allowed')}</option></select></FormField>
        <FormField hint={t('automations.field.policyHint')} label={t('automations.field.policy')}><input onChange={event => update('permission_policy_ref', event.target.value)} value={form.permission_policy_ref} /></FormField>
      </FormSection>

      <FormSection description={t('automations.triggerDescription')} index="03" title={t('automations.triggerTitle')}>
        <FormField hint={t('automations.field.triggerHint')} label={t('automations.field.trigger')} wide><select onChange={event => update('trigger_type', event.target.value)} value={form.trigger_type}>{AUTOMATION_TRIGGERS.map(item => <option key={item} value={item}>{t(`automations.triggerOption.${item}`)}</option>)}</select></FormField>
        {form.trigger_type === 'cron' ? <><FormField hint={t('automations.field.cronHint')} label={t('automations.field.cron')}><input onChange={event => update('trigger_expression', event.target.value)} placeholder="0 9 * * 1-5" value={form.trigger_expression} /></FormField><FormField hint={t('automations.field.timezoneHint')} label={t('automations.field.timezone')}><input onChange={event => update('trigger_timezone', event.target.value)} placeholder="Asia/Shanghai" value={form.trigger_timezone} /></FormField></> : null}
        {form.trigger_type === 'continuous' ? <FormField hint={t('automations.field.intervalHint')} label={t('automations.field.interval')} wide><input min="1" onChange={event => update('trigger_interval', event.target.value)} type="number" value={form.trigger_interval} /></FormField> : null}
        {form.trigger_type === 'webhook' ? <FormField hint={t('automations.field.eventTypeHint')} label={t('automations.field.eventType')} wide><input onChange={event => update('trigger_event_type', event.target.value)} placeholder="issue.updated" value={form.trigger_event_type} /></FormField> : null}
      </FormSection>
      <div className="automation-editor-note"><AlertTriangle size={14} /><span>{t('automations.auditNote')}</span></div>
    </div>
    <footer><button className="btn btn-secondary" onClick={onCancel} type="button">{t('automations.cancel')}</button><button className="btn btn-primary" disabled={submitting || !form.name.trim() || !form.workflow_ref.trim()} onClick={onSave} type="button"><Save size={14} />{submitting ? t('automations.saving') : t('automations.save')}</button></footer>
  </section></div>, document.body);
}

function FormSection({ children, description, index, title }) { return <section className="automation-form-section"><header><span>{index}</span><div><h3>{title}</h3><p>{description}</p></div></header><div className="automation-form-grid">{children}</div></section>; }

function FormField({ children, hint, label, wide = false }) { return <label className={`automation-form-field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}<small>{hint}</small></label>; }

function AutomationState({ detail = false, error = '', loading = false, onRetry }) {
  const { t } = useI18n();
  if (error) return <div className="automation-state error"><AlertTriangle size={22} /><strong>{t('automations.unavailable')}</strong><p>{error}</p><button className="btn btn-secondary" onClick={onRetry} type="button">{t('automations.retry')}</button></div>;
  if (loading) return <div className="automation-state"><RefreshCw className="is-spinning" size={22} /><strong>{t('automations.loading')}</strong></div>;
  return <div className="automation-state"><Bot size={24} /><strong>{detail ? t('automations.selectDetail') : t('automations.empty')}</strong><p>{detail ? t('automations.selectDetailDescription') : t('automations.emptyDescription')}</p></div>;
}

function triggerSummary(trigger, t) {
  if (!trigger) return '—';
  if (trigger.type === 'cron') return `${trigger.config?.expression} · ${trigger.config?.timezone}`;
  if (trigger.type === 'continuous') return t('automations.everySeconds', { seconds: trigger.config?.poll_interval_seconds });
  if (trigger.type === 'webhook') return trigger.config?.event_type || t('automations.trigger.webhook');
  return t('automations.trigger.manual');
}

function formatTime(value, language) { return value ? new Date(value).toLocaleString(language) : '—'; }
