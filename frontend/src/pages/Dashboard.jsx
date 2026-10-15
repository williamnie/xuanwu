import { useState } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import RuntimeHealthStrip from '../components/RuntimeHealthStrip';
import ActiveWorkSection from './command-center/ActiveWorkSection.jsx';
import AttentionSection from './command-center/AttentionSection.jsx';
import RecentDeliveriesSection from './command-center/RecentDeliveriesSection.jsx';
import TaskRequestsSection from './command-center/TaskRequestsSection.jsx';
import WorkEditorDialog from './work/WorkEditorDialog.jsx';
import { selectBackendOnline, selectProjects, selectRefreshData, selectWorkSummary, useDataStore } from '../store/dataStore';
import { useI18n } from '../i18n/context.js';
import './Dashboard.css';

// 首页“待我处理”（方案 5.3）：先放需要你决定的事，再看执行中与最近完成。
export default function Dashboard({ navigateTo }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const workSummary = useDataStore(selectWorkSummary);
  const [creating, setCreating] = useState(false);

  const counts = workSummary?.counts || {};
  const activeLoops = projects.filter(p => p.loop_status === 'running' || p.auto_run === 1).length;
  const needsAction = (counts.needs_user || 0) + (counts.failed || 0);
  const running = counts.in_progress || 0;
  const queued = counts.todo || 0;
  const delivered = counts.history || 0;

  return (
    <div className="dashboard-page bg-grid-tech">
      <header className="dashboard-intro">
        <div className="dashboard-intro-titlegroup">
          <div className="dashboard-eyebrow-row">
            <span className="dashboard-eyebrow">01 COMMAND_CENTER</span>
            <span className="dashboard-env-tag font-mono">[ENV: PROD_SANDBOX]</span>
          </div>
          <h1>{t('nav.commandCenter')}</h1>
          <p className="dashboard-subline font-mono">E2B-INSPIRED CODE SANDBOX &amp; AGENT WORKBENCH</p>
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

      <div className="dashboard-hud-strip" role="region" aria-label="HUD 运行监控条">
        <div className={`dashboard-hud-card ${needsAction > 0 ? 'hud-warning' : 'hud-muted'}`}>
          <div className="dashboard-hud-header">
            <span className="dashboard-hud-label">01 待你处理</span>
            <span className={`dashboard-hud-status ${needsAction > 0 ? 'status-amber' : 'status-muted'}`} />
          </div>
          <div className="dashboard-hud-value">{needsAction}</div>
          <div className="dashboard-hud-bar">
            <div className="dashboard-hud-progress" />
          </div>
        </div>
        <div className={`dashboard-hud-card ${running > 0 ? 'hud-accent' : 'hud-muted'}`}>
          <div className="dashboard-hud-header">
            <span className="dashboard-hud-label">02 运行中</span>
            <span className={`dashboard-hud-status ${running > 0 ? 'status-accent' : 'status-muted'}`} />
          </div>
          <div className="dashboard-hud-value">{running}</div>
          <div className="dashboard-hud-bar">
            <div className="dashboard-hud-progress" />
          </div>
        </div>
        <div className="dashboard-hud-card hud-neutral">
          <div className="dashboard-hud-header">
            <span className="dashboard-hud-label">03 任务队列</span>
            <span className="dashboard-hud-status status-muted" />
          </div>
          <div className="dashboard-hud-value">{queued}</div>
          <div className="dashboard-hud-bar">
            <div className="dashboard-hud-progress" />
          </div>
        </div>
        <div className="dashboard-hud-card hud-success">
          <div className="dashboard-hud-header">
            <span className="dashboard-hud-label">04 已交付成果</span>
            <span className="dashboard-hud-status status-success" />
          </div>
          <div className="dashboard-hud-value">{delivered}</div>
          <div className="dashboard-hud-bar">
            <div className="dashboard-hud-progress" />
          </div>
        </div>
        <div className={`dashboard-hud-card ${activeLoops > 0 ? 'hud-success' : 'hud-muted'}`}>
          <div className="dashboard-hud-header">
            <span className="dashboard-hud-label">05 自动化循环</span>
            <span className={`dashboard-hud-status ${activeLoops > 0 ? 'status-success' : 'status-muted'}`} />
          </div>
          <div className="dashboard-hud-value">{activeLoops}<span className="dashboard-hud-unit font-mono">/{projects.length}</span></div>
          <div className="dashboard-hud-bar">
            <div className="dashboard-hud-progress" />
          </div>
        </div>
      </div>

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
            if (work?.id) navigateTo('tasks', work.id);
          }}
          projects={projects}
        />
      ) : null}
    </div>
  );
}
