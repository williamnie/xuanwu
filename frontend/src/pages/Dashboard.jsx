import { eventsApi } from '../api/events.js';
import { useEffect } from 'react';
import { useImmer } from 'use-immer';
import { PRODUCT_NAV_LABELS } from '../brand.js';
import CodexUsagePanel from '../components/CodexUsagePanel';
import RuntimeHealthStrip from '../components/RuntimeHealthStrip';
import ActiveWorkSection from './command-center/ActiveWorkSection.jsx';
import AttentionSection from './command-center/AttentionSection.jsx';
import RecentDeliveriesSection from './command-center/RecentDeliveriesSection.jsx';
import FirstDeliveryGuide from './command-center/FirstDeliveryGuide.jsx';
import {
  selectBackendOnline,
  selectProjects,
  selectRefreshData,
  selectWorkSummary,
  useDataStore,
} from '../store/dataStore';
import { 
  Folder, 
  ListTodo, 
  CheckCircle2, 
  Terminal, 
  AlertTriangle
} from 'lucide-react';
import './Dashboard.css';

export default function Dashboard({
  navigateTo,
}) {
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [events, updateEvents] = useImmer([]);

  useEffect(() => {
    let active = true;
    eventsApi.getEventSummaries({ limit: 20 })
      .then(result => {
        if (!active) return;
        const history = [...(result?.items || [])].reverse().map(summaryDashboardEvent);
        updateEvents(draft => {
          const liveIDs = new Set(draft.map(event => event.id).filter(Boolean));
          draft.push(...history.filter(event => !liveIDs.has(event.id)));
          if (draft.length > 20) draft.length = 20;
        });
      })
      .catch(() => {});

    // 订阅全局 SSE 事件流
    const unsubscribe = eventsApi.subscribeToEvents(
      (event) => {
        if (event.type === 'agent.event') return;
        // 将新事件加入实时活动流，限制最多保存 20 条
        updateEvents((draft) => {
          draft.unshift({
            viewId: `${Date.now()}-${Math.random()}`,
            timestamp: new Date().toLocaleTimeString(),
            ...event
          });
          if (draft.length > 20) {
            draft.length = 20;
          }
        });
      },
      () => {
        // SSE 错误处理
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [updateEvents]);

  // 统计计算
  const activeLoopsCount = projects.filter(p => p.loop_status === 'running' || p.auto_run === 1).length; // 简化展示
  const counts = workSummary.counts;

  return (
    <div className="dashboard-page animate-fade-in">
      
      {/* 头部标题区域 */}
      <div className="page-intro">
        <div>
          <h1>{PRODUCT_NAV_LABELS.commandCenter}</h1>
          <p>实时监控项目 Loop 运行状态与待处理 Issue 队列</p>
        </div>
        <div className="page-intro-status">
          <span className={`status-dot ${activeLoopsCount > 0 ? 'active' : 'idle'}`}></span>
          <span className="page-intro-status-label">
            {activeLoopsCount > 0 ? `${activeLoopsCount} 个项目 Loop 运行中` : 'Loop 空闲中'}
          </span>
        </div>
      </div>

      {/* 错误警报 */}
      {!backendOnline && (
        <div className="glass-card dashboard-alert dashboard-alert-error">
          <AlertTriangle className="dashboard-alert-icon" color="var(--error)" size={24} />
          <div>
            <h4>连接后端 API 失败</h4>
            <p>无法连接到 Runner 后端服务。请确认当前 API 入口已启动且 /api/* 接口可用。</p>
          </div>
          <button className="btn btn-secondary" onClick={() => refreshData(['projects', 'workSummary'])}>
            重试连接
          </button>
        </div>
      )}

      {counts.total === 0 ? <FirstDeliveryGuide navigateTo={navigateTo} projects={projects} /> : null}

      <RuntimeHealthStrip backendOnline={backendOnline} navigateTo={navigateTo} />

      {/* 统计指标网格 */}
      <div className="grid-cols-3 dashboard-stats">
        <div className="glass-card dashboard-stat-card">
          <div className="dashboard-stat-icon dashboard-stat-icon-primary">
            <Folder size={24} />
          </div>
          <div>
            <div className="dashboard-stat-value">{projects.length}</div>
            <div className="dashboard-stat-label">总监控项目</div>
          </div>
        </div>

        <div className="glass-card dashboard-stat-card">
          <div className="dashboard-stat-icon dashboard-stat-icon-warning">
            <ListTodo size={24} />
          </div>
          <div>
            <div className="dashboard-stat-value">{counts.todo + counts.in_progress}</div>
            <div className="dashboard-stat-label">队列中 (待处理/运行中)</div>
          </div>
        </div>

        <div className="glass-card dashboard-stat-card">
          <div className="dashboard-stat-icon dashboard-stat-icon-success">
            <CheckCircle2 size={24} />
          </div>
          <div>
            <div className="dashboard-stat-value">{counts.done}</div>
            <div className="dashboard-stat-label">已自动修复 Issue</div>
          </div>
        </div>
      </div>

      <CodexUsagePanel />


      {/* 双栏布局 */}
      <div className="grid-cols-2 dashboard-main-grid">
        {/* 左栏：Active Work */}
        <div className="dashboard-col-left">
          <AttentionSection />
          <ActiveWorkSection navigateTo={navigateTo} projects={projects} />
        </div>

        {/* 右栏：系统实时通知 / 活动流 */}
        <div className="dashboard-col-right">
          <RecentDeliveriesSection navigateTo={navigateTo} projects={projects} />

          <h3 className="dashboard-events-title">
            <Terminal size={18} color="var(--primary)" /> 全局活动事件流
          </h3>

          <div className="glass-card dashboard-events-card">
            <div className="dashboard-events-header">
              <span>事件</span>
              <span>时间</span>
            </div>
            
            <div className="dashboard-events-list">
              {events.length === 0 ? (
                <div className="dashboard-events-empty">[等待事件接收...]</div>
              ) : (
                events.map(event => {
                  let badgeTone = 'default';
                  let text;

                  switch (event.type) {
                    case 'issue.created':
                      badgeTone = 'created';
                      text = `新建任务 Issue #${event.issueId}`;
                      break;
                    case 'issue.status_changed':
                      badgeTone = event.status === 'done' ? 'success' : event.status === 'failed' ? 'error' : 'warning';
                      text = `Issue #${event.issueId} 状态变更 -> ${event.status}`;
                      break;
                    case 'issue.log':
                      badgeTone = 'log';
                      text = `Issue #${event.issueId} 日志输出: ${event.text ? event.text.slice(0, 40) + '...' : ''}`;
                      break;
                    case 'issue.error':
                      badgeTone = 'error';
                      text = `Issue #${event.issueId} 执行失败: ${event.error}`;
                      break;
                    case 'runner.started':
                      badgeTone = 'success';
                      text = `项目 Loop [${event.projectId}] 已启动`;
                      break;
                    case 'runner.stopped':
                      badgeTone = 'triage';
                      text = `项目 Loop [${event.projectId}] 已停止`;
                      break;
                    case 'approval.required':
                      badgeTone = 'warning';
                      text = `Issue #${event.issueId} 触发人工审批请求 [ID: ${event.approvalId}]`;
                      break;
                    default:
                      text = JSON.stringify(event);
                  }

                  return (
                    <div key={event.viewId} className="dashboard-event-row">
                      <span className="dashboard-event-text">
                        <span className={`dashboard-event-dot is-${badgeTone}`}>•</span>
                        <span>{text}</span>
                      </span>
                      <span className="dashboard-event-time">{event.timestamp}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

function summaryDashboardEvent(event) {
  const payload = dashboardEventPayload(event.payload);
  return {
    ...event,
    viewId: `summary-${event.id}`,
    issueId: event.issue_id,
    projectId: event.project_id,
    status: payload.status || '',
    text: event.summary || payload.text || '',
    timestamp: event.created_at ? new Date(event.created_at).toLocaleTimeString() : ''
  };
}

function dashboardEventPayload(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
