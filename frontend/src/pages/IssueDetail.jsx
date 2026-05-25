import { useCallback, useEffect, useRef, useState } from 'react';
import { useImmer } from 'use-immer';
import { api } from '../api/client';
import IssueEditModal from '../components/IssueEditModal';
import { message } from '../store/toastStore';
import {
  selectRefreshAllData,
  useDataStore,
} from '../store/dataStore';
import {
  hasIssueEvent,
  issueEventKey,
  RECONCILE_INTERVAL_MS,
  sameIssue,
  sameIssueEvents,
  sameProject,
} from '../utils/stateGuards';
import {
  ArrowLeft,
  RotateCw,
  XOctagon,
  CheckCircle,
  XCircle,
  Terminal,
  AlertTriangle,
  Play,
  UserCheck,
  Pencil,
  MessageCircle,
  Send,
  History,
} from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import { canEditIssue } from '../utils/issueEdit';
import {
  REFINEMENT_FIELDS,
  deriveTriageReadiness,
  parseIssueRefinement,
  refinementDraftToIssueRefinement,
  triageReadinessMoveToTodoMessage,
} from '../utils/issueRefinement';

const COMMENT_AUTHOR_LABELS = {
  user: 'User',
  agent: 'Agent',
  system: 'System',
};

function parseEventPayload(event) {
  if (!event?.payload) return {};
  if (typeof event.payload !== 'string') return event.payload;
  try {
    return JSON.parse(event.payload);
  } catch {
    return { text: event.payload };
  }
}

function latestAutoRetryEvent(events) {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (event.type === 'issue.auto_retry_scheduled') {
      return parseEventPayload(event);
    }
  }
  return null;
}

function legacyAgentEventType(method) {
  if (method === 'item/agentMessage/delta') return 'agent.message.delta';
  if (method === 'item/commandExecution/outputDelta') return 'agent.command.output_delta';
  if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') return 'agent.file.patch';
  if (method === 'turn/started') return 'agent.turn.started';
  if (method === 'turn/completed') return 'agent.turn.completed';
  if (method === 'error') return 'agent.error';
  return '';
}

function issueLogAgentPayload(payload) {
  const rawMethod = payload.raw_method || payload.codexMethod || '';
  const text = payload.text || '';
  let type = payload.type || payload.agent_event_type || legacyAgentEventType(rawMethod);
  if (!type && rawMethod === 'item/started' && (payload.command || text.startsWith('$ '))) {
    type = 'agent.command.started';
  }
  if (!type && rawMethod === 'item/completed' && text.startsWith('--- ')) {
    type = 'agent.file.patch';
  }
  return {
    type,
    rawMethod,
    text,
    command: payload.command || '',
    path: payload.path || '',
    status: payload.status || '',
    error: payload.error || '',
  };
}

function commandLineText(agent) {
  const text = agent.command || agent.text || '';
  if (agent.text?.startsWith('! ')) return agent.text;
  return text.startsWith('$ ') ? text.slice(2) : text;
}

function formatRetryTime(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function sameIssueRuns(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;
  return current.every((run, index) => issueRunSignature(run) === issueRunSignature(next[index]));
}

function issueRunSignature(run) {
  return [
    run?.id,
    run?.attempt,
    run?.status,
    run?.provider,
    run?.provider_session_id,
    run?.provider_turn_id,
    run?.codex_thread_id,
    run?.codex_turn_id,
    run?.started_at,
    run?.ended_at,
    run?.exit_reason,
    run?.error,
  ].join('\u001f');
}

function providerLabel(provider) {
  switch (String(provider || 'codex').toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

function issueProviderIdentity(issue, runs) {
  const latestRun = [...(runs || [])].reverse().find(run =>
    run?.provider || run?.provider_session_id || run?.provider_turn_id
  );
  return {
    provider: latestRun?.provider || 'codex',
    sessionId: latestRun?.provider_session_id || issue?.codex_thread_id || '',
    turnId: latestRun?.provider_turn_id || issue?.codex_turn_id || '',
  };
}

export default function IssueDetail({ issueId, navigateTo }) {
  const refreshAllData = useDataStore(selectRefreshAllData);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentError, setCommentError] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [refinementDraft, setRefinementDraft] = useState(null);
  const [refinementDraftError, setRefinementDraftError] = useState('');
  const [refinementDraftGenerating, setRefinementDraftGenerating] = useState(false);
  const [detailState, updateDetailState] = useImmer({
    issue: null,
    project: null,
    events: [],
    runs: [],
    loading: true,
    error: null,
  });
  const { issue, project, events, runs, loading, error } = detailState;

  // 只滚动终端自己的滚动容器，避免把整个详情页抢到最底部。
  const terminalRef = useRef(null);
  const shouldFollowTerminalRef = useRef(true);
  const lastScrolledEventKeyRef = useRef('');

  const loadIssueData = useCallback(async () => {
    try {
      const issueData = await api.getIssue(issueId);
      let projData = null;
      let eventList = [];
      let runList = [];

      if (issueData) {
        // 加载关联项目
        try {
          projData = await api.getProject(issueData.project_id);
        } catch (e) {
          console.error('获取关联项目失败:', e);
        }

        // 加载现有事件日志
        try {
          eventList = await api.getIssueEvents(issueId);
        } catch (e) {
          console.error('获取日志事件失败:', e);
        }

        try {
          runList = await api.getIssueRuns(issueId);
        } catch (e) {
          console.error('获取运行历史失败:', e);
        }
      }

      updateDetailState(draft => {
        if (!sameIssue(draft.issue, issueData)) {
          draft.issue = issueData;
        }
        if (projData && !sameProject(draft.project, projData)) {
          draft.project = projData;
        }
        if (!sameIssueEvents(draft.events, eventList || [])) {
          draft.events = eventList || [];
        }
        if (!sameIssueRuns(draft.runs, runList || [])) {
          draft.runs = runList || [];
        }
        if (draft.error !== null) {
          draft.error = null;
        }
        if (draft.loading) {
          draft.loading = false;
        }
      });
    } catch {
      updateDetailState(draft => {
        draft.error = '加载任务详情失败，请检查后端 API 服务。';
        if (draft.loading) {
          draft.loading = false;
        }
      });
    }
  }, [issueId, updateDetailState]);

  useEffect(() => {
    loadIssueData();

    // 订阅 SSE 实时事件以追加最新日志
    const unsubscribe = api.subscribeToEvents((data) => {
      // 如果收到的事件是关于当前这一条 issue 的，动态更新
      if (Number(data.issueId) === Number(issueId)) {
        updateDetailState(draft => {
          if (data.type === 'issue.status_changed' && draft.issue && draft.issue.status !== data.status) {
            draft.issue.status = data.status;
          }

          if (data.type === 'issue.notification_failed' && draft.issue) {
            const error = data.error || parseEventPayload(data).error || '通知失败';
            draft.issue.error = draft.issue.error ? `${draft.issue.error}
${error}` : error;
          }

          if (data.type === 'issue.error' && draft.issue) {
            if (draft.issue.error !== data.error) {
              draft.issue.error = data.error;
            }
            if (draft.issue.status !== 'failed') {
              draft.issue.status = 'failed';
            }
          }

          // 追加到 issue 事件列表；重复的轮询/SSE 结果不再制造新数组。
          if (!hasIssueEvent(draft.events, data)) {
            draft.events.push(data);
          }
        });
      }
    });

    // SSE 是实时主通道；低频 reconcile 只用于补偿断线期间错过的事件。
    const interval = setInterval(loadIssueData, RECONCILE_INTERVAL_MS);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [issueId, loadIssueData, updateDetailState]);

  useEffect(() => {
    setCommentDraft('');
    setCommentError('');
    setCommentSubmitting(false);
    setRefinementDraft(null);
    setRefinementDraftError('');
    setRefinementDraftGenerating(false);
  }, [issueId]);

  const updateTerminalFollowState = useCallback(() => {
    const node = terminalRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldFollowTerminalRef.current = distanceToBottom < 80;
  }, []);

  // 监听真正新增的事件，只在用户仍停留在终端底部附近时跟随滚动。
  useEffect(() => {
    const lastEvent = events[events.length - 1];
    const lastEventKey = issueEventKey(lastEvent, events.length - 1);
    if (!lastEventKey || lastEventKey === lastScrolledEventKeyRef.current) {
      return;
    }

    lastScrolledEventKeyRef.current = lastEventKey;
    const node = terminalRef.current;
    if (node && shouldFollowTerminalRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [events]);

  const confirmTriageReady = () => {
    const readiness = deriveTriageReadiness({
      issue,
      commentEvents: events.filter(event => event.type === 'issue.comment'),
    });
    return !readiness || readiness.ready ||
      window.confirm(triageReadinessMoveToTodoMessage(readiness));
  };

  const handleMoveToTodo = async () => {
    if (issue?.status === 'triage' && !confirmTriageReady()) {
      return;
    }
    try {
      await api.updateIssue(issueId, { status: 'todo' });
      loadIssueData();
    } catch (err) {
      message.error('移动到 Todo 失败: ' + err.message);
    }
  };

  const handleRetry = async () => {
    try {
      await api.retryIssue(issueId);
      updateDetailState(draft => {
        draft.events = [];
      }); // 重置本地日志，等待新线程输出
      loadIssueData();
    } catch (err) {
      message.error('重新运行失败: ' + err.message);
    }
  };

  const handleCancel = async () => {
    if (window.confirm('确定要取消执行当前任务吗？')) {
      try {
        await api.cancelIssue(issueId);
        loadIssueData();
      } catch (err) {
        message.error('取消任务失败: ' + err.message);
      }
    }
  };

  const handleMarkStatus = async (targetStatus) => {
    try {
      await api.updateIssue(issueId, { status: targetStatus });
      loadIssueData();
    } catch (err) {
      message.error('更改状态失败: ' + err.message);
    }
  };

  const handleSubmitComment = async (event) => {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!body) {
      setCommentError('评论内容不能为空');
      return;
    }
    setCommentSubmitting(true);
    setCommentError('');
    try {
      const created = await api.createIssueComment(issueId, { body, author: 'user' });
      updateDetailState(draft => {
        if (!hasIssueEvent(draft.events, created)) {
          draft.events.push(created);
        }
      });
      setCommentDraft('');
    } catch (err) {
      const errorMessage = err.message || '提交评论失败';
      setCommentError(errorMessage);
      message.error('提交评论失败: ' + errorMessage);
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleGenerateRefinementDraft = async () => {
    setRefinementDraftGenerating(true);
    setRefinementDraftError('');
    try {
      const result = await api.generateIssueRefinementDraft(issueId);
      const nextDraft = refinementDraftToIssueRefinement(result?.draft);
      setRefinementDraft(nextDraft);
      setIsEditModalOpen(true);
    } catch (err) {
      const errorMessage = err.message || '生成 refinement 草稿失败';
      setRefinementDraftError(errorMessage);
      message.error('生成 refinement 草稿失败: ' + errorMessage);
    } finally {
      setRefinementDraftGenerating(false);
    }
  };

  const closeEditModal = useCallback(() => {
    setRefinementDraft(null);
    setIsEditModalOpen(false);
  }, []);

  const handleIssueSaved = useCallback((updatedIssue) => {
    updateDetailState(draft => {
      draft.issue = updatedIssue;
    });
    setRefinementDraft(null);
    setRefinementDraftError('');
    setIsEditModalOpen(false);
    refreshAllData();
  }, [refreshAllData, updateDetailState]);

  if (loading && !issue) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: '16px' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid var(--border-color)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
        <p style={{ color: 'var(--text-secondary)' }}>载入任务详情中...</p>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <XCircle color="var(--error)" size={24} />
          <h3 style={{ fontSize: '1.2rem', fontWeight: 600 }}>任务加载失败</h3>
        </div>
        <p style={{ color: 'var(--text-secondary)' }}>{error || '找不到请求的 Issue 任务数据。'}</p>
        <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => navigateTo('issues')}>
          <ArrowLeft size={16} /> 返回任务队列
        </button>
      </div>
    );
  }

  // 日志解析转换
  // 将 Go 传过来的原始 issue_events 处理成可在终端渲染的行
  const parsedDescription = parseIssueRefinement(issue.description);
  const issueBody = parsedDescription.body;
  const refinement = parsedDescription.refinement;
  const commentEvents = events.filter(event => event.type === 'issue.comment');
  const triageReadiness = deriveTriageReadiness({ issue, refinement, commentEvents });
  const autoRetryPayload = latestAutoRetryEvent(events);
  const autoRetryNextAt = issue.auto_retry_next_at || autoRetryPayload?.next_retry_at || '';
  const autoRetryReason = issue.auto_retry_reason || autoRetryPayload?.reason || '';
  const isWaitingAutoRetry = issue.status === 'todo' && Boolean(autoRetryNextAt);
  const runtimeIdentity = issueProviderIdentity(issue, runs);
  const runtimeProvider = providerLabel(runtimeIdentity.provider);
  const renderTerminalLines = () => {
    // 将相邻的、类型相同的流式 delta 事件合并，解决单字符或短片段流式输出时高度折行、字占一行的排版问题
    const getMergedEvents = () => {
      const merged = [];
      for (const event of events) {
        if (event.type === 'issue.comment') {
          continue;
        }
        const payload = parseEventPayload(event);
        const agent = issueLogAgentPayload(payload);
        const isDelta = event.type === 'issue.log' && 
          (agent.type === 'agent.message.delta' || agent.type === 'agent.command.output_delta');
        
        if (merged.length > 0) {
          const lastMerged = merged[merged.length - 1];
          const canMerge = isDelta && 
            lastMerged.type === 'issue.log' && 
            lastMerged._agent?.type === agent.type;
            
          if (canMerge) {
            const currentText = agent.text || event.text || '';
            lastMerged._textMerged += currentText;
            continue;
          }
        }
        
        merged.push({
          ...event,
          _payload: payload,
          _agent: agent,
          _textMerged: agent.text || event.text || ''
        });
      }
      return merged;
    };

    const mergedEvents = getMergedEvents();

    if (mergedEvents.length === 0) {
      return (
        <div style={{ color: '#565f89', textAlign: 'center', padding: '40px 0', fontStyle: 'italic' }}>
          [ 等待事件输出 / 当前暂无控制台日志 ]
        </div>
      );
    }

    return mergedEvents.map((event, idx) => {
      const timestamp = new Date(event.created_at || Date.now()).toLocaleTimeString();
      const payload = event._payload;

      // 1. 系统状态变更
      if (event.type === 'issue.status_changed') {
        const status = event.status || payload.status || 'unknown';
        return (
          <div key={event.id || idx} className="terminal-line header">
            &gt;&gt; [{timestamp}] 系统状态变更为: {status.toUpperCase()}
          </div>
        );
      }

      // 2. 通知失败
      if (event.type === 'issue.notification_failed') {
        const error = event.error || payload.error || '通知失败';
        return (
          <div key={event.id || idx} className="terminal-line error">
            &gt;&gt; [{timestamp}] 通知失败: {error}
          </div>
        );
      }

      // 3. 发生错误
      if (event.type === 'issue.error') {
        const error = event.error || payload.error || '未知错误';
        return (
          <div key={event.id || idx} className="terminal-line error">
            &gt;&gt; [{timestamp}] 发生异常: {error}
          </div>
        );
      }

      if (event.type === 'issue.auto_retry_scheduled') {
        return (
          <div key={event.id || idx} className="terminal-line header">
            &gt;&gt; [{timestamp}] 已安排自动重试 #{payload.attempt || '?'}，下次时间: {formatRetryTime(payload.next_retry_at)}，原因: {payload.reason || 'transient transport error'}
          </div>
        );
      }

      // 4. Codex 日志事件 (有具体的 Codex 回合、线程或输出)
      if (event.type === 'issue.log') {
        const agent = event._agent || issueLogAgentPayload(payload);
        const method = agent.rawMethod;
        // 优先使用外部已合并好的 _textMerged，若无则回退取原本事件文本
        const text = event._textMerged || agent.text || event.text || '';

        // 根据不同的通知类型，渲染不同的极客控制台线条
        if (agent.type === 'agent.message.delta') {
          return (
            <div key={event.id || idx} className="terminal-line output" style={{ color: '#9ece6a' }}>
              {text}
            </div>
          );
        }

        if (agent.type === 'agent.command.output_delta') {
          return (
            <div key={event.id || idx} className="terminal-line output">
              {text}
            </div>
          );
        }

        if (agent.type === 'agent.command.started' || agent.type === 'agent.command.completed' || method.includes('command')) {
          return (
            <div key={event.id || idx} className="terminal-line info" style={{ fontWeight: 600 }}>
              $ {commandLineText({ ...agent, text })}
            </div>
          );
        }

        // 文件修改 Patch 展现
        if (agent.type === 'agent.file.patch') {
          const patchLines = text.split('\n');
          return (
            <div key={event.id || idx} className="diff-container">
              <div style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.05)', fontSize: '0.75rem', color: '#7aa2f7', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                📂 文件修改补丁 Patch
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {patchLines.map((line, lIdx) => {
                  let lineClass = 'diff-line';
                  if (line.startsWith('+')) lineClass += ' added';
                  if (line.startsWith('-')) lineClass += ' removed';
                  return (
                    <div key={lIdx} className={lineClass}>
                      {line}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        // 默认文本日志
        return (
          <div key={event.id || idx} className="terminal-line">
            [{timestamp}] {text}
          </div>
        );
      }

      // 5. 未知格式默认渲染
      return (
        <div key={event.id || idx} className="terminal-line" style={{ opacity: 0.8 }}>
          [{timestamp}] {JSON.stringify(event)}
        </div>
      );
    });
  };

  return (
    <div className="issue-detail-page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

      {/* 头部返回与快速操作 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn btn-secondary" style={{ padding: '8px 14px' }} onClick={() => navigateTo('issues')}>
          <ArrowLeft size={16} /> 返回队列
        </button>

        <div style={{ display: 'flex', gap: '10px' }}>
          {canEditIssue(issue) && (
            <>
              <button className="btn btn-secondary" onClick={() => setIsEditModalOpen(true)}>
                <Pencil size={14} /> 编辑内容
              </button>
              <button className="btn btn-success" onClick={handleMoveToTodo}>
                <Play size={14} /> Move to Todo
              </button>
            </>
          )}

          {(issue.status === 'todo' || issue.status === 'in_progress') && (
            <button className="btn btn-danger" onClick={handleCancel}>
              <XOctagon size={14} /> 中断取消
            </button>
          )}

          {(issue.status === 'failed' || issue.status === 'cancelled' || issue.status === 'done') && (
            <button className="btn btn-primary" onClick={handleRetry}>
              <RotateCw size={14} /> 重新执行
            </button>
          )}
        </div>
      </div>

      {/* 主面板内容 */}
      <div className="issue-detail-grid grid-cols-3">

        {/* 左侧：任务细节与极客终端 */}
        <div className="issue-detail-main" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

          <div className="glass-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'var(--primary-glow)', color: 'var(--primary)', fontWeight: 600 }}>
                    {project ? project.name : issue.project_id}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    ID: #{issue.id}
                  </span>
                </div>
                <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>{issue.title}</h2>
              </div>
              <span className={`status-badge ${issue.status}`} style={{ fontSize: '0.9rem', padding: '8px 16px' }}>
                {issue.status === 'in_progress' && <span className="status-dot running"></span>}
                {issue.status}
              </span>
            </div>

            {issueBody && (
              <div style={{ marginTop: '20px', background: 'rgba(0,0,0,0.03)', padding: '16px', borderRadius: '10px', fontSize: '0.9rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>任务描述</div>
                <MarkdownPreview text={issueBody} />
              </div>
            )}
          </div>

          <IssueRefinement
            issue={issue}
            refinement={refinement}
            readiness={triageReadiness}
            onEdit={() => setIsEditModalOpen(true)}
            onMoveToTodo={handleMoveToTodo}
            onGenerateDraft={handleGenerateRefinementDraft}
            draftError={refinementDraftError}
            draftGenerating={refinementDraftGenerating}
          />

          <IssueDiscussion
            events={commentEvents}
            draft={commentDraft}
            error={commentError}
            submitting={commentSubmitting}
            onDraftChange={setCommentDraft}
            onSubmit={handleSubmitComment}
          />

          {/* 实时终端控制台 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={18} color="var(--primary)" /> Provider 代理工作终端 (实时)
            </h3>
            <div
              ref={terminalRef}
              className="terminal-view"
              style={{ minHeight: '400px' }}
              onScroll={updateTerminalFollowState}
            >
              <div className="terminal-line info" style={{ borderBottom: '1px dashed rgba(255,255,255,0.08)', paddingBottom: '8px', marginBottom: '12px' }}>
                🚀 CODEX ISSUE LOOP RUNNER DAEMON [ONLINE]
                <br />
                -------------------------------------------------
                <br />
                项目路径: {project ? project.cwd : '加载中...'}
                <br />
                Provider: {runtimeProvider}
                <br />
                Session ID: {runtimeIdentity.sessionId || '暂无'}
                <br />
                Turn ID: {runtimeIdentity.turnId || '暂无'}
              </div>

              {renderTerminalLines()}
            </div>
          </div>

        </div>

        {/* 右侧：元数据信息与运行设置 */}
        <div className="issue-detail-side" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

          {isWaitingAutoRetry && (
            <div className="glass-card" style={{ background: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)', borderLeft: '4px solid var(--warning)' }}>
              <h4 style={{ color: 'var(--warning)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <RotateCw size={18} /> 等待自动重试
              </h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
                下次重试时间：{formatRetryTime(autoRetryNextAt)}
              </p>
              {autoRetryReason && (
                <p className="issue-error-text" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  原因：{autoRetryReason}
                </p>
              )}
            </div>
          )}

          {/* 故障错误警报栏 */}
          {issue.error && (
            <div className="issue-error-card glass-card" style={{ background: 'var(--error-bg)', borderColor: 'rgba(244,63,94,0.3)', borderLeft: '4px solid var(--error)' }}>
              <h4 style={{ color: 'var(--error)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <AlertTriangle size={18} /> 执行失败阻断
              </h4>
              <p className="issue-error-text" style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                {issue.error}
              </p>
            </div>
          )}

          {/* 任务状态详情卡 */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
              任务元数据
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '0.85rem' }}>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>当前状态:</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{issue.status.toUpperCase()}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>重试尝试数:</span>
                <span style={{ fontWeight: 600 }}>{issue.attempt_count} 次</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>优先级:</span>
                <span style={{ fontWeight: 600 }}>{issue.priority === 2 ? 'High (紧急)' : issue.priority === 1 ? 'Medium (普通)' : 'Low (低)'}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Provider:</span>
                <span style={{ fontWeight: 600 }}>{runtimeProvider}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Session ID:</span>
                <code style={{ background: 'rgba(0,0,0,0.1)', padding: '4px 6px', borderRadius: '4px', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {runtimeIdentity.sessionId || '未开始分配'}
                </code>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>Turn ID:</span>
                <code style={{ background: 'rgba(0,0,0,0.1)', padding: '4px 6px', borderRadius: '4px', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {runtimeIdentity.turnId || '暂无'}
                </code>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>最后更新时间:</span>
                <span>{new Date(issue.updated_at).toLocaleString()}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>创建时间:</span>
                <span>{new Date(issue.created_at).toLocaleString()}</span>
              </div>

            </div>
          </div>

          <IssueRunsPanel runs={runs} currentStatus={issue.status} />

          {/* 人工干预区 */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <UserCheck size={18} color="var(--primary)" /> 人工状态变更干预
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              若 Codex 已经完成修改但由于一些脚本检测导致状态未能流转，或者您需要直接标记其状态，可在此手动强制修改：
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                className="btn btn-secondary btn-success"
                style={{ padding: '8px 12px', fontSize: '0.8rem', width: '100%', justifyContent: 'flex-start' }}
                onClick={() => handleMarkStatus('done')}
              >
                <CheckCircle size={14} /> 强制标记为：完成 (Done)
              </button>

              <button
                className="btn btn-secondary btn-danger"
                style={{ padding: '8px 12px', fontSize: '0.8rem', width: '100%', justifyContent: 'flex-start' }}
                onClick={() => handleMarkStatus('failed')}
              >
                <XCircle size={14} /> 强制标记为：失败 (Failed)
              </button>
            </div>
          </div>

        </div>

      </div>

      {isEditModalOpen && (
        <IssueEditModal
          issue={issue}
          initialRefinement={refinementDraft}
          onClose={closeEditModal}
          onSaved={handleIssueSaved}
        />
      )}

    </div>
  );
}

function IssueRefinement({ issue, refinement, readiness, onEdit, onMoveToTodo, onGenerateDraft, draftError, draftGenerating }) {
  const canEdit = canEditIssue(issue);
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600 }}>Refinement</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            把 triage 输入整理成执行规格；Acceptance criteria 与 Verification plan 是 Ready 条件。
          </p>
        </div>
        {readiness && (
          <span className={`triage-readiness-badge ${readiness.state}`} title={readiness.source}>
            {readiness.state}
          </span>
        )}
      </div>

      {readiness && !readiness.ready && (
        <div style={{ color: 'var(--warning)', background: 'rgba(245,158,11,0.1)', padding: '10px 12px', borderRadius: '8px', fontSize: '0.82rem' }}>
          {readiness.source} Move to Todo 前会先确认，但不会阻断手动流转。
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
        {REFINEMENT_FIELDS.map(field => (
          <RefinementItem key={field.id} label={field.label} value={refinement[field.id]} />
        ))}
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={onGenerateDraft} disabled={draftGenerating}>
            <RotateCw size={14} /> {draftGenerating ? '生成中...' : '生成 Refinement 草稿'}
          </button>
          <button className="btn btn-secondary" onClick={onEdit}>
            <Pencil size={14} /> 编辑 Refinement
          </button>
          <button className="btn btn-success" onClick={onMoveToTodo}>
            <Play size={14} /> Move to Todo
          </button>
        </div>
      )}
      {draftError && (
        <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 10px', borderRadius: '6px', fontSize: '0.8rem' }}>
          {draftError}
        </div>
      )}
    </section>
  );
}

function RefinementItem({ label, value }) {
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px', background: 'rgba(0,0,0,0.025)', minWidth: 0 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', marginBottom: '8px' }}>
        {label}
      </div>
      {value ? (
        <MarkdownPreview text={value} />
      ) : (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>未填写</span>
      )}
    </div>
  );
}

function IssueRunsPanel({ runs, currentStatus }) {
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <History size={18} color="var(--primary)" /> Runs 历史
      </h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
        当前状态是 <strong>{currentStatus}</strong>；下方按 attempt 展示每一轮独立执行记录。
      </p>

      {runs.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          暂无 run 记录，issue 进入 runner claim 后会生成第一条。
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
          {runs.map(run => (
            <IssueRunCard key={run.id} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRunCard({ run }) {
  const running = !run.ended_at;
  const error = run.error ? summarize(run.error, 160) : '';
  return (
    <article style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Attempt #{run.attempt}</span>
        <span className={`status-badge ${run.status}`} style={{ fontSize: '0.72rem', padding: '3px 8px' }}>
          {running && <span className="status-dot running"></span>}
          {run.status}
        </span>
      </div>

      <RunField label="Run ID" value={run.id} mono />
      <RunField label="Provider" value={providerLabel(run.provider)} />
      <RunField label="Session" value={run.provider_session_id || run.codex_thread_id || '暂无'} mono />
      <RunField label="Turn" value={run.provider_turn_id || run.codex_turn_id || '暂无'} mono />
      <RunField label="开始" value={formatDateTime(run.started_at)} />
      <RunField label="结束" value={running ? '运行中' : formatDateTime(run.ended_at)} />
      {run.exit_reason && <RunField label="退出原因" value={run.exit_reason} />}
      {error && (
        <div style={{ color: 'var(--error)', background: 'var(--error-bg)', borderRadius: '8px', padding: '8px', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
          {error}
        </div>
      )}
    </article>
  );
}

function RunField({ label, value, mono = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'var(--font-mono)' : undefined, fontSize: mono ? '0.72rem' : '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function summarize(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1)}…`;
}

function IssueDiscussion({ events, draft, error, submitting, onDraftChange, onSubmit }) {
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <MessageCircle size={18} color="var(--primary)" />
        <h3 style={{ fontSize: '1.15rem', fontWeight: 600 }}>讨论 / Discussion</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
        {events.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>
            当前暂无讨论，适合补充背景、验收标准或澄清问题。
          </p>
        ) : (
          events.map((event, index) => (
            <IssueComment key={event.id || index} event={event} />
          ))
        )}
      </div>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <textarea
          className="form-control"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="补充背景、验收标准或澄清问题，支持 Markdown..."
          rows={4}
          disabled={submitting}
          style={{ width: '100%', resize: 'vertical' }}
        />
        {error && (
          <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 10px', borderRadius: '6px', fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-start' }}>
          <Send size={14} /> {submitting ? '提交中...' : '发表评论'}
        </button>
      </form>
    </section>
  );
}

function IssueComment({ event }) {
  const payload = parseEventPayload(event);
  const author = payload.author || 'user';
  const body = payload.body || payload.text || '';
  const createdAt = event.created_at ? new Date(event.created_at).toLocaleString() : '';

  return (
    <article style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '12px', background: 'rgba(0,0,0,0.025)', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--primary)' }}>
          {COMMENT_AUTHOR_LABELS[author] || author}
        </span>
        {createdAt && (
          <time style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {createdAt}
          </time>
        )}
      </div>
      <MarkdownPreview text={body} />
    </article>
  );
}
