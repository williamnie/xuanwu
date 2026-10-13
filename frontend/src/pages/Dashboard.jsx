import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { commandCenterApi } from '../api/commandCenter.js';
import RuntimeHealthStrip from '../components/RuntimeHealthStrip';
import InboxRequests from './command-center/InboxRequests.jsx';
import { selectBackendOnline, selectProjects, selectRefreshData, useDataStore } from '../store/dataStore';
import { workBlockReason } from './work/workActions.js';
import { useI18n } from '../i18n/context.js';
import './Dashboard.css';

export default function Dashboard({ navigateTo, onCreate }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [glance,setGlance] = useState({ active: [], completed_today: [], error: '', loading: true });
  useEffect(()=>{
    let active=true;
    let pending=false;
    const controller=new AbortController();
    const load=()=>{ if(pending)return; pending=true; return commandCenterApi.getTaskGlance({signal:controller.signal}).then(data=>{if(active)setGlance({...data,error:'',loading:false});}).catch(error=>{if(active)setGlance(current=>({...current,error:error.message,loading:false}));}).finally(()=>{pending=false;});};
    load();const interval=setInterval(()=>{if(document.visibilityState==='visible')load();},30000);
    return()=>{active=false;controller.abort();clearInterval(interval);};
  },[]);
  return <div className="dashboard-page">
    <header className="dashboard-intro"><div><span className="dashboard-eyebrow">INBOX</span><h1>{t('nav.commandCenter')}</h1></div></header>
    {!backendOnline&&<div className="dashboard-connection-error" role="alert"><AlertTriangle size={16}/><p>当前状态可能不是最新，请恢复连接后核对。</p><button className="btn btn-secondary" onClick={()=>refreshData(['projects','workSummary'])} type="button">重试连接</button></div>}
    <RuntimeHealthStrip backendOnline={backendOnline} navigateTo={navigateTo}/>
    <InboxRequests navigateTo={navigateTo} onCreate={onCreate}/>
    {glance.error&&<p role="alert">进展暂不可用：{glance.error}</p>}
    <div className="dashboard-work-grid">
      <section className="dashboard-compact-tasks"><header><h2>执行中</h2><button className="btn btn-secondary" onClick={()=>navigateTo('work')} type="button">查看全部</button></header>{glance.loading?<p role="status">正在读取进展…</p>:(glance.active||[]).map(work=><button className="dashboard-task-row" key={work.id} onClick={()=>navigateTo('work',work.id)} type="button"><strong>{work.title}</strong><span>{workBlockReason(work,projects.find(project=>project.id===work.owner?.project_id))||t(`status.${work.status}`)}</span></button>)}{!glance.loading&&!glance.error&&!glance.active?.length&&<p>暂时没有执行中的任务</p>}</section>
      <section className="dashboard-compact-tasks"><header><h2>今天完成</h2></header>{(glance.completed_today||[]).map(({work,completed_at})=>work&&<button className="dashboard-task-row" key={work.id} onClick={()=>navigateTo('work',work.id)} type="button"><strong>{work.title}</strong><time>{new Date(completed_at).toLocaleTimeString()}</time></button>)}{!glance.loading&&!glance.error&&!glance.completed_today?.length&&<p>暂无可确认的今日完成记录</p>}{glance.completion_time_unknown>0&&<p>部分历史任务没有完成时间，可在任务页查看。</p>}</section>
    </div>
  </div>;
}
