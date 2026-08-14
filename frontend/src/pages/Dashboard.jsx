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
  selectIssues,
  selectProjects,
  selectRefreshData,
  useDataStore,
} from '../store/dataStore';
import { 
  Folder, 
  ListTodo, 
  CheckCircle2, 
  Terminal, 
  AlertTriangle
} from 'lucide-react';

export default function Dashboard({
  navigateTo,
}) {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
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
  const inProgressIssues = issues.filter(i => i.status === 'in_progress');
  const todoIssues = issues.filter(i => i.status === 'todo');
  const doneIssues = issues.filter(i => i.status === 'done');

  return (
    <div className="dashboard-page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      
      {/* 头部标题区域 */}
      <div className="page-intro" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>{PRODUCT_NAV_LABELS.commandCenter}</h1>
          <p style={{ color: 'var(--text-muted)' }}>实时监控项目 Loop 运行状态与待处理 Issue 队列</p>
        </div>
        <div className="page-intro-status" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className={`status-dot ${activeLoopsCount > 0 ? 'active' : 'idle'}`}></span>
          <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            {activeLoopsCount > 0 ? `${activeLoopsCount} 个项目 Loop 运行中` : 'Loop 空闲中'}
          </span>
        </div>
      </div>

      {/* 错误警报 */}
      {!backendOnline && (
        <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', display: 'flex', gap: '16px', alignItems: 'center', padding: '16px 24px', background: 'var(--error-bg)' }}>
          <AlertTriangle color="var(--error)" size={24} style={{ flexShrink: 0 }} />
          <div>
            <h4 style={{ color: 'var(--error)', fontWeight: 600, marginBottom: '2px' }}>连接后端 API 失败</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>无法连接到 Runner 后端服务。请确认当前 API 入口已启动且 /api/* 接口可用。</p>
          </div>
          <button className="btn btn-secondary" style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => refreshData(['projects', 'issues'])}>
            重试连接
          </button>
        </div>
      )}

      {issues.length === 0 ? <FirstDeliveryGuide navigateTo={navigateTo} projects={projects} /> : null}

      <RuntimeHealthStrip backendOnline={backendOnline} navigateTo={navigateTo} />

      {/* 统计指标网格 */}
      <div className="grid-cols-3">
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ padding: '12px', borderRadius: 'var(--radius-lg)', background: 'var(--primary-glow)', color: 'var(--primary)' }}>
            <Folder size={24} />
          </div>
          <div>
            <div style={{ fontSize: '2.2rem', fontWeight: 700, lineHeight: 1 }}>{projects.length}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>总监控项目</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ padding: '12px', borderRadius: 'var(--radius-lg)', background: 'var(--warning-glow)', color: 'var(--warning)' }}>
            <ListTodo size={24} />
          </div>
          <div>
            <div style={{ fontSize: '2.2rem', fontWeight: 700, lineHeight: 1 }}>{todoIssues.length + inProgressIssues.length}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>队列中 (待处理/运行中)</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ padding: '12px', borderRadius: 'var(--radius-lg)', background: 'var(--success-glow)', color: 'var(--success)' }}>
            <CheckCircle2 size={24} />
          </div>
          <div>
            <div style={{ fontSize: '2.2rem', fontWeight: 700, lineHeight: 1 }}>{doneIssues.length}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>已自动修复 Issue</div>
          </div>
        </div>
      </div>

      <CodexUsagePanel />


      {/* 双栏布局 */}
      <div className="grid-cols-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        {/* 左栏：Active Work */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', minWidth: 0 }}>
          <AttentionSection />
          <ActiveWorkSection navigateTo={navigateTo} projects={projects} />
        </div>

        {/* 右栏：系统实时通知 / 活动流 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', minWidth: 0 }}>
          <RecentDeliveriesSection navigateTo={navigateTo} projects={projects} />

          <h3 style={{ fontSize: '1.2rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={18} color="var(--primary)" /> 全局活动事件流
          </h3>

          <div className="glass-card" style={{ flex: 1, maxHeight: '500px', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '16px 20px', background: 'var(--bg-terminal)', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>事件</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>时间</span>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.85rem' }}>
              {events.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  [等待事件接收...]
                </div>
              ) : (
                events.map(event => {
                  let badgeColor = '#7aa2f7'; // default blue
                  let text;

                  switch (event.type) {
                    case 'issue.created':
                      badgeColor = '#bb9af7';
                      text = `新建任务 Issue #${event.issueId}`;
                      break;
                    case 'issue.status_changed':
                      badgeColor = event.status === 'done' ? 'var(--success)' : event.status === 'failed' ? 'var(--error)' : 'var(--warning)';
                      text = `Issue #${event.issueId} 状态变更 -> ${event.status}`;
                      break;
                    case 'issue.log':
                      badgeColor = '#cfc9c2';
                      text = `Issue #${event.issueId} 日志输出: ${event.text ? event.text.slice(0, 40) + '...' : ''}`;
                      break;
                    case 'issue.error':
                      badgeColor = 'var(--error)';
                      text = `Issue #${event.issueId} 执行失败: ${event.error}`;
                      break;
                    case 'runner.started':
                      badgeColor = 'var(--success)';
                      text = `项目 Loop [${event.projectId}] 已启动`;
                      break;
                    case 'runner.stopped':
                      badgeColor = 'var(--triage)';
                      text = `项目 Loop [${event.projectId}] 已停止`;
                      break;
                    case 'approval.required':
                      badgeColor = 'var(--warning)';
                      text = `Issue #${event.issueId} 触发人工审批请求 [ID: ${event.approvalId}]`;
                      break;
                    default:
                      text = JSON.stringify(event);
                  }

                  return (
                    <div key={event.viewId} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', minWidth: 0, fontFamily: 'var(--font-mono)', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '6px' }}>
                      <span style={{ color: '#a9b1d6', display: 'flex', gap: '8px', flex: 1, minWidth: 0 }}>
                        <span style={{ color: badgeColor }}>•</span>
                        <span style={{ minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{text}</span>
                      </span>
                      <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem', flexShrink: 0, marginLeft: '8px' }}>{event.timestamp}</span>
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
