import { isInboxStateEvent } from "../command-center/inboxRefreshModel.js";
import { formatRelativeTime } from "../command-center/activeWorkModel.js";
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, Plus } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { eventsApi } from '../../api/events.js';
import { message } from '../../store/toastStore.js';
import { useI18n } from '../../i18n/context.js';
import { selectProjects, useDataStore } from '../../store/dataStore.js';
import { executeWorkMove, workBlockReason, workStatusActions } from './workActions.js';
import WorkEditorDialog from './WorkEditorDialog.jsx';
import './TaskList.css';

const TASK_FILTERS = { active: ['todo', 'in_progress'], attention: ['triage', 'needs_user', 'failed'], done: ['done'], all: [], triage: ['triage'], failed: ['failed'], archive: ['done', 'cancelled'] };
const FILTER_LABELS = { active: '进行中', attention: '待你处理', done: '已完成', all: '全部' };

export default function TaskList({ navigateTo, initialProject = '', onPageContextChange, onCreate, routeFilters = {}, onRouteFiltersChange }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const initialFilters = { scope: TASK_FILTERS[routeFilters.focus] ? routeFilters.focus : 'active', project: initialProject, query: routeFilters.query || '', source: routeFilters.source || '' };
  const [filters, setLocalFilters] = useState(initialFilters);
  const setFilters = change => {
    const next = typeof change === 'function' ? change(filters) : change;
    setLocalFilters(next);
    onRouteFiltersChange?.({ filterProject: next.project, focusFilter: next.scope, taskQuery: next.query, taskSource: next.source });
  };
  useEffect(() => {
    setLocalFilters(current => ({ ...current, project: initialProject, query: routeFilters.query || '', source: routeFilters.source || '', scope: TASK_FILTERS[routeFilters.focus] ? routeFilters.focus : 'active' }));
  }, [initialProject, routeFilters.focus, routeFilters.query, routeFilters.source]);
  const [state, setState] = useState({ items: [], loading: true, error: '', next: '', page: 1, more: false });
  const [editing, setEditing] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState('');
  const request = useRef(null);
  const refreshState = useRef({paged:false,loading:false});
  const { scope, project, query, source } = filters;
  const load = useCallback(async (cursor = '', page = 1) => {
    refreshState.current.loading=true;
    if (cursor || page > 1) refreshState.current.paged=true;
    request.current?.abort();
    const controller = new AbortController();request.current = controller;
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const result = await workApi.getWorks({ cursor, page, projectId: project, query, source, statuses: TASK_FILTERS[scope], includeDiagnostics: true }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!cursor && page === 1) refreshState.current.paged=false;
      setState(current => ({ updated:cursor || page > 1 ? current.updated : false,items: cursor || page > 1 ? [...current.items, ...(result.items || [])] : result.items || [], loading: false, error: '', next: result.next_cursor || '', page: result.page || page, more: result.has_more === true }));
    } catch (error) { if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: error.message || '读取任务失败' })); }
    finally { if(request.current===controller)refreshState.current.loading=false; }
  }, [project, query, scope, source]);
  useEffect(() => { load(); return () => request.current?.abort(); }, [load]);
  useEffect(() => {
    let timer=0;
    const notify=()=>setState(current=>({...current,updated:true}));
    const unsubscribe=eventsApi.subscribeToEvents(event=>{
      if(!isInboxStateEvent(event.type))return;
      if(refreshState.current.paged||refreshState.current.loading){notify();return;}
      if(!timer)timer=setTimeout(()=>{timer=0;if(refreshState.current.paged||refreshState.current.loading)notify();else load();},2000);
    });
    const interval=setInterval(()=>{if(document.visibilityState==='visible'&&!refreshState.current.paged&&!refreshState.current.loading)load();},30000);
    return()=>{unsubscribe();clearTimeout(timer);clearInterval(interval);};
  }, [load]);
  useEffect(() => { onPageContextChange?.({ page_id: 'tasks', project_id: project }); }, [onPageContextChange, project]);
  const perform = async (work, target) => {
    setBusy(work.id);
    try { await executeWorkMove(work, target);message.success('操作已提交');setPending(null);await load(); }
    catch (error) { message.error(error.status === 409 ? '任务已更新，请核对最新状态' : error.message);if(error.status === 409) await load(); }
    finally { setBusy(''); }
  };
  return <section className="task-list-page">
    <header className="task-list-toolbar">
      <div className="task-list-filters" role="group" aria-label="任务状态筛选">{Object.entries(FILTER_LABELS).map(([id,label]) => <button className="btn btn-secondary" aria-pressed={scope===id} key={id} onClick={() => setFilters(current => ({ ...current, scope:id }))} type="button">{label}</button>)}</div>
      <button className="btn btn-primary" onClick={() => onCreate(project)} type="button"><Plus size={14}/>新建任务</button>
      <button className="btn btn-secondary" aria-label="刷新任务" disabled={state.loading} onClick={() => load()} type="button"><RefreshCw size={14}/></button>
    </header>
    <div className="task-list-search">
      <select className="form-control" aria-label="按项目筛选" value={project} onChange={event=>setFilters(current=>({...current,project:event.target.value}))}><option value="">全部项目</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select className="form-control" aria-label="按来源筛选" value={source} onChange={event=>setFilters(current=>({...current,source:event.target.value}))}><option value="">全部来源</option><option value="github">GitHub</option></select>
      <label><Search size={14}/><input className="form-control" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event=>setFilters(current=>({...current,query:event.target.value}))}/></label>
    </div>
    {state.updated && <p role="status">任务有更新，已加载的列表保持不变。<button className="btn btn-secondary" disabled={state.loading} onClick={()=>load()} type="button">刷新任务列表</button></p>}
    {state.error && <div role="alert">{state.error}<button className="btn btn-secondary" onClick={()=>load()} type="button">重试</button></div>}
    {state.loading && !state.items.length && <p role="status">正在读取任务…</p>}
    {!state.error && !state.loading && !state.items.length && <div className="task-list-empty"><p>这里还没有任务</p><button className="btn btn-secondary" onClick={()=>onCreate(project)} type="button">新建任务</button></div>}
    <div className="task-list-rows">{state.items.map(work=>{
      const projectRow=projects.find(item=>item.id===work.owner?.project_id);
      const actions=workStatusActions(work.status);
      const primary=actions.find(action=>['enqueue','retry'].includes(action.operation));
      return <article className="task-list-row" key={work.id}>
        <span className="status-dot" data-status={work.status}/>
        <button className="task-list-title" onClick={()=>navigateTo('work',work.id)} type="button"><strong>{work.title}</strong><small>{t(`status.${work.status}`)} · {projectRow?.name || work.owner?.project_id}</small><span>{workBlockReason(work,projectRow) || work.progress?.latest?.summary || work.goal?.split('\n')[0]}</span></button>
        <time title={new Date(work.updated_at).toLocaleString()}>{formatRelativeTime(work.updated_at) || new Date(work.updated_at).toLocaleString()}</time>
        <div className="task-list-actions">{primary && <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={()=>work.status==='in_progress'?setPending({work,action:primary}):perform(work,primary.target)} type="button">{primary.label}</button>}
          <details><summary aria-label={`更多操作 ${work.title}`}>更多</summary><div>
            {actions.filter(action=>action!==primary).map(action=><button className="btn btn-secondary" disabled={Boolean(busy)} key={`${action.operation}:${action.target}`} onClick={()=>action.operation==='cancel'||action.operation==='retry'?setPending({work,action}):perform(work,action.target)} type="button">{action.label}</button>)}
            {work.status !== 'in_progress' && <button className="btn btn-secondary" onClick={()=>setEditing(work)} type="button">编辑</button>}
          </div></details>
        </div>
      </article>;
    })}</div>
    {pending && <div role="alert"><p>确认{pending.action.label}“{pending.work.title}”？{pending.work.status==='in_progress'?'当前执行会被中断。':''}</p><button className="btn btn-secondary" disabled={Boolean(busy)} onClick={()=>perform(pending.work,pending.action.target)} type="button">确认</button><button className="btn btn-secondary" onClick={()=>setPending(null)} type="button">返回</button></div>}
    {state.more && <button className="btn btn-secondary" disabled={state.loading} onClick={()=>load(state.next,state.next?1:state.page+1)} type="button">{state.loading?'加载中…':'加载更多'}</button>}
    {editing && <WorkEditorDialog mode="edit" work={editing} projects={projects} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);load();}}/>}
  </section>;
}
