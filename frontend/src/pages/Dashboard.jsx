import { useState } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import RuntimeHealthStrip from '../components/RuntimeHealthStrip';
import ActiveWorkSection from './command-center/ActiveWorkSection.jsx';
import AttentionSection from './command-center/AttentionSection.jsx';
import RecentDeliveriesSection from './command-center/RecentDeliveriesSection.jsx';
import TaskRequestsSection from './command-center/TaskRequestsSection.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { selectBackendOnline, selectProjects, selectRefreshData, useDataStore } from '../store/dataStore';
import { useI18n } from '../i18n/context.js';
import './Dashboard.css';

// 首页“待我处理”（方案 5.3）：先放需要你决定的事，再看执行中与最近完成。
export default function Dashboard({ navigateTo }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [creating, setCreating] = useState(false);

  return (
    <div className="dashboard-page">
      <header className="dashboard-intro">
        <div>
          <span className="dashboard-eyebrow">INBOX</span>
          <h1>{t('nav.commandCenter')}</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} type="button">
          <Plus size={14} /> {t('board.newWork')}
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

      <TaskRequestsSection navigateTo={navigateTo} onCreate={() => setCreating(true)} />
      <AttentionSection />
      <div className="dashboard-work-grid">
        <ActiveWorkSection limit={5} navigateTo={navigateTo} projects={projects} />
        <RecentDeliveriesSection limit={5} navigateTo={navigateTo} projects={projects} />
      </div>

      {creating ? (
        <WorkEditorDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={(work) => {
            setCreating(false);
            refreshData(['workSummary']);
            if (work?.id) navigateTo('work', work.id);
          }}
          projects={projects}
        />
      ) : null}
    </div>
  );
}
