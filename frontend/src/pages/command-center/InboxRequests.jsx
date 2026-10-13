import { inboxRefreshDecision } from "./inboxRefreshModel.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { workApi } from '../../api/work.js';
import { eventsApi } from '../../api/events.js';
import { buildWorkActionPayload } from '../workDetailModel.js';
import { workHumanReviewCopy } from '../workHumanReviewCopy.js';
import { useI18n } from '../../i18n/context.js';
import { message } from '../../store/toastStore.js';
import { attentionActionPayload } from './attentionModel.js';
import { humanReviewPayload, providerApprovalPayload, proposalDecisionPayload, piActionDecisionPayload, mergeInboxPages, reviewConflictMessage } from './inboxModel.js';
import './InboxRequests.css';
const LegacyAttention = lazy(() => import('./AttentionSection.jsx'));

export default function InboxRequests({ navigateTo, onCreate, workId = '', embedded = false }) {
  const [state,setState] = useState({ items: [], loading: true, error: '', next: '', complete: false, unsupported: false, updated: false });
  const request = useRef(null);
  const refreshState = useRef({loading:false,paged:false});
  const eventVersion = useRef(0);
  const load = useCallback(async (cursor = '') => {
    refreshState.current.loading = true;
    if (cursor) refreshState.current.paged = true;
    const version = eventVersion.current;
    request.current?.abort(); const controller = new AbortController();request.current = controller;
    setState(current=>({...current,loading:true,error:''}));
    try {
      const result = await commandCenterApi.getInbox({cursor,workId}, {signal:controller.signal});
      if(controller.signal.aborted)return;
      if(result.complete !== true) throw new Error('完整待处理数据暂不可用，当前结果不能代表全部事项');
      if (!cursor) refreshState.current.paged = false;
      setState(current=>({updated:(cursor && current.updated) || eventVersion.current !== version,items:cursor?mergeInboxPages(current.items,result.items||[]):result.items||[],loading:false,error:'',next:result.next_cursor||'',complete:true,unsupported:false}));
    } catch(error){if(!controller.signal.aborted)setState(current=>({...current,loading:false,error:error.message,complete:false,unsupported:error.status===404}));}
    finally { if (request.current === controller) refreshState.current.loading = false; }
  },[workId]);
  useEffect(()=>{refreshState.current={loading:false,paged:false};load();return()=>request.current?.abort();},[load]);
  useEffect(()=>{
    let timer=0;
    const notify=()=>setState(current=>({...current,updated:true}));
    const unsubscribe=eventsApi.subscribeToEvents(event=>{
      const decision=inboxRefreshDecision(event.type,refreshState.current);
      if(decision==='ignore')return;
      eventVersion.current += 1;
      if(decision==='notify'){notify();return;}
      if(!timer)timer=setTimeout(()=>{
        timer=0;
        if(refreshState.current.loading||refreshState.current.paged)notify();else load();
      },2000);
    });
    const interval=setInterval(()=>{if(document.visibilityState==='visible'&&!refreshState.current.loading&&!refreshState.current.paged)load();},30000);
    return()=>{unsubscribe();clearTimeout(timer);clearInterval(interval);};
  },[load]);
  const items=embedded?state.items.filter(item=>item.source==='attention'):state.items;
  if(embedded && !state.error && !state.loading && !items.length && !state.next && !state.updated) return null;
  return <section className="inbox-requests" aria-busy={state.loading}>
    {!embedded&&<header><h2>待你处理</h2><button className="btn btn-secondary" aria-label="刷新待处理请求" disabled={state.loading} onClick={()=>load()} type="button"><RefreshCw size={14}/></button></header>}
    {state.updated&&<p role="status">有更新，当前已加载的请求保持不变。<button className="btn btn-secondary" disabled={state.loading} onClick={()=>load()} type="button">刷新待处理列表</button></p>}
    {state.error&&<p role="alert">{state.error}<button className="btn btn-secondary" onClick={()=>load()} type="button">刷新核对</button></p>}
    {state.loading&&!items.length&&<p role="status">正在读取待处理请求…</p>}
    {!state.loading&&!state.error&&state.complete&&!items.length&&!state.next&&!embedded&&<div className="inbox-empty"><p>没有需要你处理的事</p><button className="btn btn-secondary" onClick={onCreate} type="button">新建任务</button></div>}
    {state.unsupported&&!embedded&&<div><p role="status">当前只显示部分来源，最多 25 项且助手动作限最近 7 天；请结合任务页核对。</p><Suspense fallback={<p>正在读取可用的待处理来源…</p>}><LegacyAttention /></Suspense></div>}
    <div className="inbox-request-list">{items.map(item=>item.source==='human_review'?<HumanReviewInboxCard item={item} key={item.key} navigateTo={navigateTo} refresh={()=>load()}/>:item.source==='attention'?<AttentionInboxCard item={item} key={item.key} navigateTo={navigateTo} refresh={()=>load()}/>:item.source==='failed_work'?<FailedWorkCard item={item} key={item.key} navigateTo={navigateTo} refresh={()=>load()}/>:<article className="inbox-request-card" key={item.key}><strong>{item.work?.title}</strong><p>玄武正在整理问题</p><TaskLink item={item} navigateTo={navigateTo}/></article>)}</div>
    {state.next&&<button className="btn btn-secondary" disabled={state.loading} onClick={()=>load(state.next)} type="button">加载更多请求</button>}
  </section>;
}
function TaskLink({item,navigateTo}){const ids=item.work_ids?.length?item.work_ids:[item.work_id].filter(Boolean);return ids.map(id=><button className="btn btn-secondary" key={id} onClick={()=>navigateTo('work',id)} type="button">查看任务{ids.length>1?` #${id.split(':').at(-1)}`:''}</button>);}
function HumanReviewInboxCard({item,navigateTo,refresh}){
  const {t}=useI18n();const [action,setAction]=useState('');const [comment,setComment]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const request=item.request;const copy=workHumanReviewCopy(request.kind,t);
  const submit=async choice=>{setBusy(true);setError('');try{await workApi.answerWorkHumanReview(item.work_id,humanReviewPayload(request,choice,comment));message.success('已提交，请查看任务后续状态');setAction('');await refresh();}catch(err){let text=err.message;if(err.status===409){try{text=reviewConflictMessage(request,await workApi.getWork(item.work_id));}catch{text='请求已失效，请刷新核对';}await refresh();}setError(text);}finally{setBusy(false);}};
  return <article className="inbox-request-card"><small>{request.kind==='decision'?'决定':request.kind==='risk_acceptance'?'风险授权':'交付验收'}</small><h3>{request.question}</h3>{request.recommendation&&<p>玄武建议：{request.recommendation}</p>}{request.consequences&&<p>影响：{request.consequences}</p>}{request.acceptance_summary?.length>0&&<ul>{request.acceptance_summary.map(text=><li key={text}>{text}</li>)}</ul>}{request.excluded_scope?.length>0&&<p>不包含：{request.excluded_scope.join('；')}</p>}
    {error&&<p role="alert">{error}</p>}
    {action&&<label>意见<textarea className="form-control" aria-label="审核意见" value={comment} onChange={event=>setComment(event.target.value)}/></label>}
    <div className="inbox-request-actions">{!action?<><button className="btn btn-secondary" disabled={busy} onClick={()=>submit('accept')} type="button">{copy.accept}</button>{request.kind!=='risk_acceptance'&&<button className="btn btn-secondary" disabled={busy} onClick={()=>setAction('request_changes')} type="button">要求修改</button>}{request.kind!=='acceptance'&&<button className="btn btn-secondary" disabled={busy} onClick={()=>setAction('reject')} type="button">拒绝</button>}</>:<><button className="btn btn-secondary" disabled={busy||!comment.trim()} onClick={()=>submit(action)} type="button">提交意见</button><button className="btn btn-secondary" disabled={busy} onClick={()=>setAction('')} type="button">返回</button></>}<TaskLink item={item} navigateTo={navigateTo}/></div>
  </article>;
}
function AttentionInboxCard({item,navigateTo,refresh}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [comment,setComment]=useState('');const decision=item.decision;
  const submit=async action=>{setBusy(true);setError('');try{
    if(!decision)await commandCenterApi.controlAttention(item.attention_id,action,attentionActionPayload(item.attention,action));
    else if(decision.kind==='provider_approval')await commandCenterApi.controlAttention(item.attention_id,action,providerApprovalPayload(decision,comment));
    else if(decision.kind==='proposal')await commandCenterApi.controlAttention(item.attention_id,action,proposalDecisionPayload(decision,comment));
    else if(decision.kind==='pi_action')await commandCenterApi.controlAttention(item.attention_id,action,piActionDecisionPayload(decision,comment));
    else throw new Error('未知请求类型，请查看处理记录');
    message.success('决定已提交，请查看后续处理状态');await refresh();
  }catch(err){let text=err.message;if(err.status===409||err.status===404){try{const latest=await commandCenterApi.getAttention(item.attention_id);const current=latest.decisions?.find(value=>value.ref===decision?.ref);text=!decision ? latest.attention?.revision !== item.attention.revision ? '事项内容已更新，已刷新当前状态' : err.message : !current?'请求已处理或失效':current.gate?.freshness==='expired'?'请求已过期':current.gate?.freshness==='terminal'?'请求已在别处处理':'操作条件已变化，请重新核对';}catch{text='请求已失效，请刷新核对';}await refresh();}setError(text);}finally{setBusy(false);}};
  const active=decision&&['candidate','pending','proposed','delivered','resolve_failed','changes_requested','snoozed'].includes(decision.status);
  return <article className="inbox-request-card"><small>{decision?.kind==='provider_approval'?'执行工具审批':decision?.kind==='proposal'?'操作提案':decision?.kind==='pi_action'?'助手动作':'待处理事项'}</small><h3>{decision?.summary||item.attention.summary}</h3>{decision&&<p>来源：{decision.provider||item.attention.details?.source||'玄武'} · 风险：{decision.risk||'未提供'}</p>}{decision?.actions?.length>0&&<ul>{decision.actions.map(action=><li key={action.id}>{action.summary} · {action.risk}</li>)}</ul>}{decision?.gate?.reason&&<p>{decision.gate.reason}</p>}
    {error&&<p role="alert">{error}</p>}{active&&<label>意见（可选）<input className="form-control" value={comment} onChange={event=>setComment(event.target.value)}/></label>}
    <div className="inbox-request-actions">{decision?<>{active&&decision.gate?.can_approve&&<button className="btn btn-secondary" disabled={busy} onClick={()=>submit('approve')} type="button">批准</button>}{active&&<button className="btn btn-secondary" disabled={busy} onClick={()=>submit('reject')} type="button">拒绝</button>}{active&&decision.kind==='pi_action'&&decision.project_id&&decision.capability_id&&decision.gate?.can_approve&&<details><summary>更多授权</summary><p>本项目的相同工具调用将使用持续授权，仍受权限与安全门禁限制。</p><button className="btn btn-secondary" disabled={busy} onClick={()=>submit('approve_always')} type="button">持续授权</button></details>}{!active&&<span>请求已处理或暂不可操作</span>}</>:<><button className="btn btn-secondary" disabled={busy} onClick={()=>submit('acknowledge')} type="button">确认收到</button><button className="btn btn-secondary" disabled={busy||item.attention.priority==='p0'} onClick={()=>submit('snooze')} type="button">稍后处理</button></>}<TaskLink item={item} navigateTo={navigateTo}/></div>
  </article>;
}
function FailedWorkCard({item,navigateTo,refresh}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const retry=async()=>{setBusy(true);try{await workApi.controlWork(item.work_id,'retry',buildWorkActionPayload(item.work,'retry'));message.success('重试已提交');await refresh();}catch(err){setError(err.status===409?'任务已更新，请核对最新状态':err.message);await refresh();}finally{setBusy(false);}};
  return <article className="inbox-request-card"><small>失败任务</small><h3>{item.work?.title}</h3><p>{item.failure_reason||item.work?.failure?.reason||item.work?.error||'执行没有完成，请查看详情后重试'}</p>{error&&<p role="alert">{error}</p>}<div className="inbox-request-actions"><button className="btn btn-secondary" disabled={busy} onClick={retry} type="button">重试</button><TaskLink item={item} navigateTo={navigateTo}/></div></article>;
}
