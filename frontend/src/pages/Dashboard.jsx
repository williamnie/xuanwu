import { AlertTriangle, ArrowRight, MessageSquare } from 'lucide-react';
import RuntimeHealthStrip from '../components/RuntimeHealthStrip';
import ActiveWorkSection from './command-center/ActiveWorkSection.jsx';
import AttentionSection from './command-center/AttentionSection.jsx';
import RecentDeliveriesSection from './command-center/RecentDeliveriesSection.jsx';
import { selectBackendOnline, selectProjects, selectRefreshData, selectWorkSummary, useDataStore } from '../store/dataStore';
import { useI18n } from '../i18n/context.js';
import './Dashboard.css';

export default function Dashboard({ navigateTo }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const counts = workSummary.counts;
  const openSettings = section => navigateTo('settings', null, '', '', { settingsSection: section });

  return (
    <div className="dashboard-page">
      <header className="dashboard-intro">
        <div>
          <span className="dashboard-eyebrow">WORKSPACE</span>
          <h1>{t('nav.commandCenter')}</h1>
          <p>先处理需要你决定的事，再看工作进展。</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigateTo('ask-xuanwu')} type="button">
          <MessageSquare size={14} /> 交给玄武
        </button>
      </header>

      {!backendOnline && (
        <div className="dashboard-connection-error" role="alert">
          <AlertTriangle size={16} />
          <div><strong>暂时无法连接玄武</strong><p>当前内容可能不是最新状态，恢复连接后可继续查看。</p></div>
          <button className="btn btn-secondary" onClick={() => refreshData(['projects', 'workSummary'])} type="button">重试连接</button>
        </div>
      )}
      <RuntimeHealthStrip backendOnline={backendOnline} navigateTo={navigateTo} />

      <dl className="dashboard-facts" aria-label="工作概况">
        <div><dt>已接入项目</dt><dd>{projects.length}</dd></div>
        <div><dt>等待执行</dt><dd>{counts.todo}</dd></div>
        <div><dt>正在执行</dt><dd>{counts.in_progress}</dd></div>
        <div><dt>累计完成</dt><dd>{counts.done}</dd></div>
      </dl>

      <AttentionSection />
      <div className="dashboard-work-grid">
        <ActiveWorkSection navigateTo={navigateTo} projects={projects} />
        <RecentDeliveriesSection navigateTo={navigateTo} projects={projects} />
      </div>
      <nav className="dashboard-links" aria-label="更多工作入口">
        <button onClick={() => navigateTo('work')} type="button">查看全部工作 <ArrowRight size={14} /></button>
        <button onClick={() => navigateTo('analytics')} type="button">查看统计分析 <ArrowRight size={14} /></button>
        <button onClick={() => openSettings('general')} type="button">管理项目 <ArrowRight size={14} /></button>
        <button onClick={() => openSettings('advanced:activity')} type="button">查看活动记录 <ArrowRight size={14} /></button>
      </nav>
    </div>
  );
}
