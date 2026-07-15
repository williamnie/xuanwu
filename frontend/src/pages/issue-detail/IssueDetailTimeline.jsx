import { useEffect, useRef } from 'react';
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  Clock3,
  History,
  Play,
  RotateCw,
  Settings2,
  StickyNote,
  Terminal,
  UserCheck,
  XOctagon,
} from 'lucide-react';
import MarkdownPreview from '../../components/editor/MarkdownPreview';
import { issueEventKey } from '../../utils/stateGuards';
import { runSelectionReasonLabel } from '../../utils/agentProfiles';
import {
  commandLineText,
  interruptEventLabel,
  interruptReasonLabel,
  issueLogAgentPayload,
  issueStatusFromEvent,
  mergeIssueLogEvents,
  parseEventPayload,
} from './issueDetailEventAdapters';
import { formatDateTime, providerLabel, summarize } from './issueDetailFormatters';
import { LOG_PAGE_SIZE } from './issueDetailConstants';

const COMMENT_AUTHOR_LABELS = {
  user: 'User',
  agent: 'Agent',
  system: 'System',
};
const FALLBACK_LOG_TIMESTAMP = Date.now();

export function IssueDetailTabs({ activeTab, events, logsLoaded, logEvents, unseenLogCount, runs, onChange }) {
  return (
    <div className="issue-detail-tabs" role="tablist" aria-label="Issue 详情分区">
      <IssueDetailTab
        active={activeTab === 'activity'}
        icon={<Activity size={15} />}
        label="活动"
        count={events.length}
        onClick={() => onChange('activity')}
      />
      <IssueDetailTab
        active={activeTab === 'logs'}
        icon={<Terminal size={15} />}
        label="日志"
        count={logsLoaded ? logEvents.length : unseenLogCount}
        hasUpdate={!logsLoaded && unseenLogCount > 0}
        onClick={() => onChange('logs')}
      />
      <IssueDetailTab
        active={activeTab === 'runs'}
        icon={<History size={15} />}
        label="Runs"
        count={runs.length}
        onClick={() => onChange('runs')}
      />
      <IssueDetailTab
        active={activeTab === 'advanced'}
        icon={<Settings2 size={15} />}
        label="高级"
        onClick={() => onChange('advanced')}
      />
    </div>
  );
}

function IssueDetailTab({ active, icon, label, count, hasUpdate = false, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`issue-detail-tab${active ? ' active' : ''}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {Number(count) > 0 && <em>{count}</em>}
      {hasUpdate && <i aria-label="有新内容" />}
    </button>
  );
}

export function IssueActivityTimeline({ events }) {
  const orderedEvents = [...events].reverse();
  return (
    <section className="issue-activity-panel">
      <div className="issue-tab-panel-header">
        <div>
          <span className="issue-section-eyebrow">Audit trail</span>
          <h2><Activity size={17} /> 活动记录</h2>
          <p>状态、内部备注和系统事件按时间汇总；Provider 输出已独立到“日志”。</p>
        </div>
      </div>

      {orderedEvents.length === 0 ? (
        <div className="issue-activity-empty">暂无活动事件。</div>
      ) : (
        <div className="issue-activity-list">
          {orderedEvents.map((event, index) => (
            <IssueActivityItem key={event.id || issueEventKey(event, index)} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueActivityItem({ event }) {
  const view = activityEventView(event);
  return (
    <article className={`issue-activity-item ${view.tone}`}>
      <div className="issue-activity-marker">{view.icon}</div>
      <div className="issue-activity-content">
        <div className="issue-activity-title">
          <strong>{view.title}</strong>
          <time>{formatDateTime(event.created_at)}</time>
        </div>
        {view.markdown ? (
          <div className="issue-activity-markdown"><MarkdownPreview text={view.detail} /></div>
        ) : view.detail ? (
          <p>{view.detail}</p>
        ) : null}
      </div>
    </article>
  );
}

function activityEventView(event) {
  const payload = parseEventPayload(event);
  if (event.type === 'issue.comment') {
    const author = payload.author || 'user';
    return {
      title: `内部备注 · ${COMMENT_AUTHOR_LABELS[author] || author}`,
      detail: payload.body || payload.text || '',
      icon: <StickyNote size={14} />,
      markdown: true,
      tone: 'note',
    };
  }
  if (event.type === 'issue.created') {
    return { title: '任务已创建', detail: 'Issue 已写入任务队列。', icon: <Play size={13} />, tone: 'neutral' };
  }
  if (event.type === 'issue.status_changed') {
    const status = issueStatusFromEvent(event) || 'unknown';
    const reason = payload.reason ? ` · ${interruptReasonLabel(payload.reason)}` : '';
    return { title: `状态变更 → ${status}`, detail: `任务状态已更新${reason}`, icon: <Activity size={13} />, tone: status === 'failed' ? 'danger' : 'status' };
  }
  if (event.type === 'issue.run_selected') {
    const runProvider = providerLabel(payload.provider_id || payload.provider);
    const selection = runSelectionReasonLabel(payload.selection_reason);
    return {
      title: '已选择执行配置',
      detail: [runProvider, selection, payload.profile_id && `Profile ${payload.profile_id}`].filter(Boolean).join(' · '),
      icon: <Settings2 size={13} />,
      tone: 'neutral',
    };
  }
  if (event.type === 'issue.verification_reviewed') {
    return {
      title: `人工验证 → ${payload.action || 'reviewed'}`,
      detail: payload.comment || `任务状态更新为 ${payload.status || 'unknown'}`,
      icon: <UserCheck size={14} />,
      tone: 'verification',
    };
  }
  if (event.type === 'issue.retry_after_scheduled') {
    return {
      title: '已安排重试等待',
      detail: [payload.retry_after_at, payload.reason].filter(Boolean).join(' · '),
      icon: <Clock3 size={13} />,
      tone: 'neutral',
    };
  }
  if (event.type === 'issue.error' || event.type === 'issue.notification_failed') {
    return {
      title: event.type === 'issue.error' ? '执行异常' : '通知失败',
      detail: event.error || payload.error || payload.message || '未提供错误详情',
      icon: <AlertTriangle size={14} />,
      tone: 'danger',
    };
  }
  if (event.type === 'issue.verification_report') {
    return {
      title: `Verifier report${payload.recommendation ? ` · ${payload.recommendation}` : ''}`,
      detail: payload.summary || '已记录结构化验证报告。',
      icon: <ClipboardCheck size={14} />,
      tone: 'verification',
    };
  }
  if (event.type?.startsWith('issue.interrupt')) {
    return {
      title: interruptEventLabel(event.type),
      detail: [payload.reason && interruptReasonLabel(payload.reason), payload.error || event.error].filter(Boolean).join(' · '),
      icon: <XOctagon size={14} />,
      tone: event.type === 'issue.interrupt_failed' ? 'danger' : 'neutral',
    };
  }
  return {
    title: event.type || '系统事件',
    detail: summarize(
      payload.message || payload.text || payload.summary || payload.error || event.text || event.error || '',
      240,
    ),
    icon: <Clock3 size={13} />,
    tone: 'neutral',
  };
}

export function IssueLogTimeline({
  activeTab,
  project,
  runtimeProvider,
  runtimeIdentity,
  logEvents,
  logsLoaded,
  logsLoading,
  logsHasMore,
  logsError,
  loadIssueLogs,
}) {
  const terminalRef = useRef(null);
  const shouldFollowTerminalRef = useRef(true);
  const lastScrolledEventKeyRef = useRef('');

  useEffect(() => {
    const lastEvent = logEvents[logEvents.length - 1];
    const lastEventKey = issueEventKey(lastEvent, logEvents.length - 1);
    if (!lastEventKey || lastEventKey === lastScrolledEventKeyRef.current) return;

    lastScrolledEventKeyRef.current = lastEventKey;
    const node = terminalRef.current;
    if (node && shouldFollowTerminalRef.current) node.scrollTop = node.scrollHeight;
  }, [logEvents]);

  if (activeTab !== 'logs') return null;

  const updateTerminalFollowState = () => {
    const node = terminalRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldFollowTerminalRef.current = distanceToBottom < 80;
  };

  return (
    <div className="issue-logs-panel">
      <div className="issue-tab-panel-header">
        <div>
          <span className="issue-section-eyebrow">Lazy loaded · {LOG_PAGE_SIZE} / page</span>
          <h2><Terminal size={17} /> Provider 运行日志</h2>
          <p>仅在打开本页签时读取最新日志；历史内容按需向前加载。</p>
        </div>
        <div className="issue-log-actions">
          {logsHasMore && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={logsLoading}
              onClick={() => loadIssueLogs({ beforeId: logEvents[0]?.id })}
            >
              <Clock3 size={14} /> 加载更早日志
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={logsLoading} onClick={() => loadIssueLogs()}>
            <RotateCw size={14} /> 刷新最新
          </button>
        </div>
      </div>

      {logsError && <div className="issue-log-error">{logsError}</div>}
      {logsLoading && !logsLoaded ? (
        <div className="issue-tab-loading">正在读取最新日志…</div>
      ) : (
        <div
          ref={terminalRef}
          className="terminal-view issue-detail-terminal"
          onScroll={updateTerminalFollowState}
        >
          <div className="terminal-runtime-strip">
            <span>Provider <strong>{runtimeProvider}</strong></span>
            <span>Session <strong>{runtimeIdentity.sessionId || '暂无'}</strong></span>
            <span>Turn <strong>{runtimeIdentity.turnId || '暂无'}</strong></span>
            <span>Path <strong>{project?.cwd || '加载中'}</strong></span>
          </div>
          <TerminalLines events={logEvents} />
        </div>
      )}
    </div>
  );
}

function TerminalLines({ events }) {
  const mergedEvents = mergeIssueLogEvents(events);
  if (mergedEvents.length === 0) {
    return (
      <div style={{ color: '#565f89', textAlign: 'center', padding: '40px 0', fontStyle: 'italic' }}>
        [ 等待事件输出 / 当前暂无控制台日志 ]
      </div>
    );
  }

  return mergedEvents.map((event, idx) => {
    const timestamp = new Date(event.created_at || FALLBACK_LOG_TIMESTAMP).toLocaleTimeString();
    const payload = event._payload;

    if (event.type === 'issue.status_changed') {
      const status = issueStatusFromEvent(event) || 'unknown';
      const reason = payload.reason ? `（原因：${interruptReasonLabel(payload.reason)}）` : '';
      return <div key={event.id || idx} className="terminal-line header">&gt;&gt; [{timestamp}] 系统状态变更为: {status.toUpperCase()}{reason}</div>;
    }

    if (event.type === 'issue.notification_failed') {
      const error = event.error || payload.error || '通知失败';
      return <div key={event.id || idx} className="terminal-line error">&gt;&gt; [{timestamp}] 通知失败: {error}</div>;
    }

    if (event.type === 'issue.error') {
      const error = event.error || payload.error || '未知错误';
      return <div key={event.id || idx} className="terminal-line error">&gt;&gt; [{timestamp}] 发生异常: {error}</div>;
    }

    if (event.type === 'issue.interrupt_requested' || event.type === 'issue.interrupted' || event.type === 'issue.interrupt_failed') {
      const error = event.error || payload.error || '';
      return (
        <div key={event.id || idx} className={`terminal-line ${event.type === 'issue.interrupt_failed' ? 'error' : 'info'}`}>
          &gt;&gt; [{timestamp}] {interruptEventLabel(event.type)}；原因: {interruptReasonLabel(payload.reason)}；Thread: {payload.thread_id || event.threadId || '未知'}；Turn: {payload.turn_id || event.turnId || '未知'}{error ? `；错误: ${error}` : ''}
        </div>
      );
    }

    if (event.type === 'issue.log') {
      const agent = event._agent || issueLogAgentPayload(payload);
      const method = agent.rawMethod;
      const text = event._textMerged || agent.text || event.text || '';

      if (agent.type === 'agent.message.delta') {
        return <div key={event.id || idx} className="terminal-line output" style={{ color: '#9ece6a' }}>{text}</div>;
      }
      if (agent.type === 'agent.command.output_delta') {
        return <div key={event.id || idx} className="terminal-line output">{text}</div>;
      }
      if (agent.type === 'agent.command.started' || agent.type === 'agent.command.completed' || method.includes('command')) {
        return <div key={event.id || idx} className="terminal-line info" style={{ fontWeight: 600 }}>$ {commandLineText({ ...agent, text })}</div>;
      }
      if (agent.type === 'agent.file.patch') {
        const patchLines = text.split('\n');
        return (
          <div key={event.id || idx} className="diff-container">
            <div style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.05)', fontSize: '0.75rem', color: '#7aa2f7', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              📂 文件修改补丁 Patch
            </div>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {patchLines.map((line, lineIndex) => {
                let lineClass = 'diff-line';
                if (line.startsWith('+')) lineClass += ' added';
                if (line.startsWith('-')) lineClass += ' removed';
                return <div key={lineIndex} className={lineClass}>{line}</div>;
              })}
            </div>
          </div>
        );
      }
      return <div key={event.id || idx} className="terminal-line">[{timestamp}] {text}</div>;
    }

    return (
      <div key={event.id || idx} className="terminal-line" style={{ opacity: 0.8 }}>
        [{timestamp}] {JSON.stringify(event)}
      </div>
    );
  });
}
