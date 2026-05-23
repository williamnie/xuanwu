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
} from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import { canEditIssue } from '../utils/issueEdit';

export default function IssueDetail({ issueId, navigateTo }) {
  const refreshAllData = useDataStore(selectRefreshAllData);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [detailState, updateDetailState] = useImmer({
    issue: null,
    project: null,
    events: [],
    loading: true,
    error: null,
  });
  const { issue, project, events, loading, error } = detailState;

  // 只滚动终端自己的滚动容器，避免把整个详情页抢到最底部。
  const terminalRef = useRef(null);
  const shouldFollowTerminalRef = useRef(true);
  const lastScrolledEventKeyRef = useRef('');

  const loadIssueData = useCallback(async () => {
    try {
      const issueData = await api.getIssue(issueId);
      let projData = null;
      let eventList = [];

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

          if (data.type === 'issue.error' && draft.issue) {
            if (draft.issue.error !== data.error) {
              draft.issue.error = data.error;
            }
            if (draft.issue.status !== 'failed') {
              draft.issue.status = 'failed';
            }
          }

          // 追加事件到终端列表；重复的轮询/SSE 结果不再制造新数组。
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

  const handleEnqueue = async () => {
    try {
      await api.enqueueIssue(issueId);
      loadIssueData();
    } catch (err) {
      message.error('加入队列失败: ' + err.message);
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

  const closeEditModal = useCallback(() => {
    setIsEditModalOpen(false);
  }, []);

  const handleIssueSaved = useCallback((updatedIssue) => {
    updateDetailState(draft => {
      draft.issue = updatedIssue;
    });
    setIsEditModalOpen(false);
    refreshAllData();
  }, [refreshAllData, updateDetailState]);

  const parseEventPayload = (event) => {
    if (!event?.payload) return {};
    if (typeof event.payload !== 'string') return event.payload;
    try {
      return JSON.parse(event.payload);
    } catch {
      return { text: event.payload };
    }
  };

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
  const renderTerminalLines = () => {
    // 将相邻的、类型相同的流式 delta 事件合并，解决单字符或短片段流式输出时高度折行、字占一行的排版问题
    const getMergedEvents = () => {
      const merged = [];
      for (const event of events) {
        const payload = parseEventPayload(event);
        const isDelta = event.type === 'issue.log' && 
          (payload.codexMethod === 'item/agentMessage/delta' || 
           payload.codexMethod === 'item/commandExecution/outputDelta');
        
        if (merged.length > 0) {
          const lastMerged = merged[merged.length - 1];
          const canMerge = isDelta && 
            lastMerged.type === 'issue.log' && 
            lastMerged._payload?.codexMethod === payload.codexMethod;
            
          if (canMerge) {
            const currentText = payload.text || event.text || '';
            lastMerged._textMerged += currentText;
            continue;
          }
        }
        
        merged.push({
          ...event,
          _payload: payload,
          _textMerged: payload.text || event.text || ''
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

      // 2. 发生错误
      if (event.type === 'issue.error') {
        const error = event.error || payload.error || '未知错误';
        return (
          <div key={event.id || idx} className="terminal-line error">
            &gt;&gt; [{timestamp}] 发生异常: {error}
          </div>
        );
      }

      // 3. Codex 日志事件 (有具体的 Codex 回合、线程或输出)
      if (event.type === 'issue.log') {
        const method = payload.codexMethod || '';
        // 优先使用外部已合并好的 _textMerged，若无则回退取原本事件文本
        const text = event._textMerged || payload.text || event.text || '';

        // 根据不同的通知类型，渲染不同的极客控制台线条
        if (method === 'item/agentMessage/delta') {
          return (
            <div key={event.id || idx} className="terminal-line output" style={{ color: '#9ece6a' }}>
              {text}
            </div>
          );
        }

        if (method === 'item/commandExecution/outputDelta') {
          return (
            <div key={event.id || idx} className="terminal-line output">
              {text}
            </div>
          );
        }

        if (method.includes('command')) {
          return (
            <div key={event.id || idx} className="terminal-line info" style={{ fontWeight: 600 }}>
              $ {text}
            </div>
          );
        }

        // 文件修改 Patch 展现
        if (method === 'item/fileChange/patchUpdated') {
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

      // 未知格式默认渲染
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
              <button className="btn btn-success" onClick={handleEnqueue}>
                <Play size={14} /> 启动运行
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

            {issue.description && (
              <div style={{ marginTop: '20px', background: 'rgba(0,0,0,0.03)', padding: '16px', borderRadius: '10px', fontSize: '0.9rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>任务描述</div>
                <MarkdownPreview text={issue.description} />
              </div>
            )}
          </div>

          {/* 实时终端控制台 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={18} color="var(--primary)" /> Codex 智能代理工作终端 (实时)
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
                线程 ID: {issue.codex_thread_id || '暂无'}
                <br />
                回合 ID: {issue.codex_turn_id || '暂无'}
              </div>

              {renderTerminalLines()}
            </div>
          </div>

        </div>

        {/* 右侧：元数据信息与运行设置 */}
        <div className="issue-detail-side" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

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
                <span style={{ color: 'var(--text-muted)' }}>Codex 线程:</span>
                <code style={{ background: 'rgba(0,0,0,0.1)', padding: '4px 6px', borderRadius: '4px', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {issue.codex_thread_id || '未开始分配'}
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
          onClose={closeEditModal}
          onSaved={handleIssueSaved}
        />
      )}

    </div>
  );
}
