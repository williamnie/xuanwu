import { useCallback, useEffect, useRef, useState } from 'react';
import { useImmer } from 'use-immer';
import { api } from '../api/client';
import IssueEditModal from '../components/IssueEditModal';
import { message } from '../store/toastStore';
import {
  selectRefreshData,
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
  ClipboardCheck,
  History,
  ExternalLink,
  Trash2,
  Activity,
  ChevronDown,
  Clock3,
  FileText,
  MoreHorizontal,
  Settings2,
  StickyNote,
} from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import { canEditIssue } from '../utils/issueEdit';
import { deriveIssueExecutionSummary } from '../utils/issueExecutionSummary';
import { issueRunSessionRef } from '../utils/issueRuns';
import {
  serviceTierLabel,
  serviceTierOptions,
  serviceTierPayload,
  serviceTierRunLabel,
} from '../utils/serviceTier';
import {
  issueRunProfileLabel,
  runCapabilitySummary,
  runSelectionReasonLabel,
  summarizeAgentProfile,
} from '../utils/agentProfiles';
import {
  hasMcpRequirements,
  issueMcpRequirementSummary,
  mcpRequirementStatus,
} from '../utils/mcpRequirements';
import IssueSupervisorPanel from './IssueSupervisorPanel';
import './IssueDetail.css';

const LOG_PAGE_SIZE = 200;
const ACTIVE_SUPERVISOR_STATUSES = new Set(['todo', 'in_progress']);

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

function issueStatusFromEvent(event) {
  const directStatus = typeof event?.status === 'string' ? event.status : '';
  if (directStatus) return directStatus;
  const payload = parseEventPayload(event);
  return typeof payload.status === 'string' ? payload.status : '';
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
  let type = payload.agent_event_type || legacyAgentEventType(rawMethod);
  if (!type && rawMethod === 'item/started' && (payload.command || text.startsWith('$ '))) {
    type = 'agent.command.started';
  }
  if (!type && rawMethod === 'item/completed' && text.startsWith('--- ')) {
    type = 'agent.file.patch';
  }
  if (!type) type = payload.type || '';
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

async function readOptional(read, label, fallback = null) {
  try {
    return await read();
  } catch (error) {
    console.error(label, error);
    return fallback;
  }
}

function commandLineText(agent) {
  const text = agent.command || agent.text || '';
  if (agent.text?.startsWith('! ')) return agent.text;
  return text.startsWith('$ ') ? text.slice(2) : text;
}

function interruptEventLabel(type) {
  if (type === 'issue.interrupt_requested') return '已请求中断 Codex turn';
  if (type === 'issue.interrupted') return '中断回收完成';
  if (type === 'issue.interrupt_failed') return '中断请求失败';
  return '中断事件';
}

function interruptReasonLabel(reason) {
  if (reason === 'session_interrupt') return '来自 Session interrupt';
  if (reason === 'issue_cancel') return '来自 Issue cancel';
  if (reason === 'interrupted_by_status_change') return '状态变更触发中断';
  return reason || 'interrupted';
}

function sameIssueRuns(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;
  return current.every((run, index) => issueRunSignature(run) === issueRunSignature(next[index]));
}

function sameAgentProfiles(current = [], next = []) {
  if (current === next) return true;
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  if (current.length !== next.length) return false;
  return current.every((profile, index) => agentProfileSignature(profile) === agentProfileSignature(next[index]));
}

function sameSupervisorView(current, next) {
  return JSON.stringify(current || null) === JSON.stringify(next || null);
}

function agentProfileSignature(profile) {
  return [
    profile?.id,
    profile?.name,
    profile?.provider,
    profile?.model,
    profile?.reasoning_effort,
    profile?.approval_policy,
    profile?.sandbox,
    profile?.service_tier,
  ].join('\u001f');
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
    run?.agent_profile_id,
    run?.capability_summary,
    run?.selection_reason,
    run?.service_tier,
    run?.service_tier_source,
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
  const refreshData = useDataStore(selectRefreshData);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('activity');
  const [commentDraft, setCommentDraft] = useState('');
  const [commentError, setCommentError] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [verifierGenerating, setVerifierGenerating] = useState(false);
  const [verifierError, setVerifierError] = useState('');
  const [verificationReviewAction, setVerificationReviewAction] = useState('');
  const [verificationReviewDraft, setVerificationReviewDraft] = useState('');
  const [verificationReviewSubmitting, setVerificationReviewSubmitting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingIssue, setDeletingIssue] = useState(false);
  const [detailState, updateDetailState] = useImmer({
    issue: null,
    project: null,
    events: [],
    logEvents: [],
    logsLoaded: false,
    logsLoading: false,
    logsHasMore: false,
    logsError: '',
    unseenLogCount: 0,
    runs: [],
    profiles: [],
    supervisor: null,
    loading: true,
    error: null,
  });
  const {
    issue,
    project,
    events,
    logEvents,
    logsLoaded,
    logsLoading,
    logsHasMore,
    logsError,
    unseenLogCount,
    runs,
    profiles,
    supervisor,
    loading,
    error,
  } = detailState;

  // 只滚动终端自己的滚动容器，避免把整个详情页抢到最底部。
  const terminalRef = useRef(null);
  const shouldFollowTerminalRef = useRef(true);
  const lastScrolledEventKeyRef = useRef('');

  const loadIssueData = useCallback(async (options = {}) => {
    const { includeProfiles = false } = options;
    try {
      const issueData = await api.getIssue(issueId);
      let projData = null;
      let eventList = [];
      let runList = [];
      let profileList;
      let supervisorData = null;

      if (issueData) {
        const [
          nextProject,
          nextEvents,
          nextRuns,
          nextProfiles,
          nextSupervisor,
        ] = await Promise.all([
          readOptional(() => api.getProject(issueData.project_id), '获取关联项目失败:'),
          readOptional(
            () => api.getIssueEventSummaries(issueId, { excludeTypes: ['issue.log'] }),
            '获取活动事件失败:',
            [],
          ),
          readOptional(() => api.getIssueRuns(issueId), '获取运行历史失败:', []),
          includeProfiles
            ? readOptional(() => api.getAgentProfiles(), '获取 Agent Profiles 失败:', [])
            : Promise.resolve(undefined),
          readOptional(() => api.getIssueSupervisor(issueId), '获取 supervisor 状态失败:', null),
        ]);
        projData = nextProject;
        eventList = nextEvents || [];
        runList = nextRuns || [];
        profileList = Array.isArray(nextProfiles) ? nextProfiles : undefined;
        supervisorData = nextSupervisor;
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
        if (Array.isArray(profileList) && !sameAgentProfiles(draft.profiles, profileList)) {
          draft.profiles = profileList;
        }
        if (!sameSupervisorView(draft.supervisor, supervisorData)) {
          draft.supervisor = supervisorData;
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
    loadIssueData({ includeProfiles: true });

    // 订阅 SSE 实时事件以追加最新日志
    const unsubscribe = api.subscribeToEvents((data) => {
      // 如果收到的事件是关于当前这一条 issue 的，动态更新
      if (Number(data.issueId) === Number(issueId)) {
        updateDetailState(draft => {
          if (data.type === 'issue.status_changed' && draft.issue) {
            const nextStatus = issueStatusFromEvent(data);
            if (nextStatus && draft.issue.status !== nextStatus) {
              draft.issue.status = nextStatus;
            }
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

          // 日志只在用户打开 Logs 后驻留；其余轻量事件进入活动流。
          if (data.type === 'issue.log') {
            if (draft.logsLoaded && !hasIssueEvent(draft.logEvents, data)) {
              draft.logEvents.push(data);
            } else if (!draft.logsLoaded) {
              draft.unseenLogCount += 1;
            }
          } else if (!hasIssueEvent(draft.events, data)) {
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

  const loadIssueLogs = useCallback(async ({ beforeId = '' } = {}) => {
    updateDetailState(draft => {
      draft.logsLoading = true;
      draft.logsError = '';
    });
    try {
      const nextLogs = await api.getIssueEvents(issueId, {
        beforeId,
        limit: LOG_PAGE_SIZE,
        types: ['issue.log'],
      });
      updateDetailState(draft => {
        const page = Array.isArray(nextLogs) ? nextLogs : [];
        if (beforeId) {
          const existingIDs = new Set(draft.logEvents.map(event => event.id).filter(Boolean));
          draft.logEvents.unshift(...page.filter(event => !existingIDs.has(event.id)));
        } else {
          draft.logEvents = page;
          draft.unseenLogCount = 0;
        }
        draft.logsHasMore = page.length === LOG_PAGE_SIZE;
        draft.logsLoaded = true;
        draft.logsLoading = false;
      });
    } catch (loadError) {
      updateDetailState(draft => {
        draft.logsError = loadError.message || '加载日志失败';
        draft.logsLoading = false;
      });
    }
  }, [issueId, updateDetailState]);

  useEffect(() => {
    if (activeTab !== 'logs' || logsLoaded || logsLoading) return;
    loadIssueLogs();
  }, [activeTab, loadIssueLogs, logsLoaded, logsLoading]);

  useEffect(() => {
    setActiveTab('activity');
    setCommentDraft('');
    setCommentError('');
    setCommentSubmitting(false);
    setVerifierGenerating(false);
    setVerifierError('');
    setVerificationReviewAction('');
    setVerificationReviewDraft('');
    setVerificationReviewSubmitting(false);
    setDeleteConfirmOpen(false);
    setDeletingIssue(false);
    updateDetailState(draft => {
      draft.logEvents = [];
      draft.logsLoaded = false;
      draft.logsLoading = false;
      draft.logsHasMore = false;
      draft.logsError = '';
      draft.unseenLogCount = 0;
    });
  }, [issueId, updateDetailState]);

  const updateTerminalFollowState = useCallback(() => {
    const node = terminalRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    shouldFollowTerminalRef.current = distanceToBottom < 80;
  }, []);

  // 监听真正新增的事件，只在用户仍停留在终端底部附近时跟随滚动。
  useEffect(() => {
    const lastEvent = logEvents[logEvents.length - 1];
    const lastEventKey = issueEventKey(lastEvent, logEvents.length - 1);
    if (!lastEventKey || lastEventKey === lastScrolledEventKeyRef.current) {
      return;
    }

    lastScrolledEventKeyRef.current = lastEventKey;
    const node = terminalRef.current;
    if (node && shouldFollowTerminalRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logEvents]);

  const handleMoveToTodo = async () => {
    try {
      await api.updateIssue(issueId, { status: 'todo', ...serviceTierPayload(issue.service_tier) });
      message.success('Issue 已移动到 Todo');
      loadIssueData();
    } catch (err) {
      message.error('移动到 Todo 失败: ' + err.message);
    }
  };

  const handleRetry = async () => {
    try {
      await api.retryIssue(issueId, serviceTierPayload(issue.service_tier));
      updateDetailState(draft => {
        draft.logEvents = [];
        draft.logsLoaded = false;
        draft.logsHasMore = false;
        draft.unseenLogCount = 0;
      }); // 重置本地日志，等待新线程输出
      loadIssueData();
    } catch (err) {
      message.error('重新运行失败: ' + err.message);
    }
  };

  const handleServiceTierChange = async (serviceTier) => {
    try {
      const updated = await api.updateIssue(issueId, serviceTierPayload(serviceTier));
      updateDetailState(draft => {
        draft.issue = updated;
      });
      refreshData(['issues']);
    } catch (err) {
      message.error('更新执行速度失败: ' + err.message);
    }
  };

  const handleCancel = async () => {
    try {
      await api.cancelIssue(issueId);
      loadIssueData();
    } catch (err) {
      message.error('取消任务失败: ' + err.message);
    }
  };

  const handleDelete = async () => {
    if (issue?.status === 'in_progress') {
      message.warning('运行中的 Issue 不能删除，请先中断取消');
      setDeleteConfirmOpen(false);
      return;
    }
    setDeletingIssue(true);
    try {
      await api.deleteIssue(issueId);
      message.success(`Issue #${issueId} 已删除`);
      refreshData(['issues']);
      navigateTo('issues');
    } catch (err) {
      message.error('删除任务失败: ' + err.message);
    } finally {
      setDeletingIssue(false);
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

  const handleVerificationReview = async (action, comment = '') => {
    setVerificationReviewSubmitting(true);
    try {
      await api.reviewIssueVerification(issueId, { action, comment: comment.trim() });
      message.success('验证处理已提交');
      setVerificationReviewAction('');
      setVerificationReviewDraft('');
      loadIssueData();
      refreshData(['issues']);
    } catch (err) {
      message.error('验证处理失败: ' + err.message);
    } finally {
      setVerificationReviewSubmitting(false);
    }
  };

  const handleSubmitComment = async (event) => {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!body) {
      setCommentError('内部备注不能为空');
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
      const errorMessage = err.message || '保存内部备注失败';
      setCommentError(errorMessage);
      message.error('保存内部备注失败: ' + errorMessage);
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleGenerateVerifierReport = async () => {
    setVerifierGenerating(true);
    setVerifierError('');
    try {
      const result = await api.generateIssueVerifierReport(issueId);
      updateDetailState(draft => {
        if (result?.event && !hasIssueEvent(draft.events, result.event)) {
          draft.events.push(result.event);
        }
      });
      message.success('Verifier report 已生成');
      loadIssueData();
    } catch (err) {
      const errorMessage = err.message || '生成 verifier report 失败';
      setVerifierError(errorMessage);
      message.error('生成 verifier report 失败: ' + errorMessage);
    } finally {
      setVerifierGenerating(false);
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
    refreshData(['issues']);
  }, [refreshData, updateDetailState]);

  const handleCopyText = useCallback(async (text) => {
    try {
      await copyTextToClipboard(text);
      message.success('已复制到剪贴板');
    } catch (err) {
      message.error(err.message || '复制失败');
    }
  }, []);

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
  // 将后端传过来的原始 issue_events 处理成可在终端渲染的行
  const issueBody = String(issue.description || '').trim();
  const commentEvents = events.filter(event => event.type === 'issue.comment');
  const runtimeIdentity = issueProviderIdentity(issue, runs);
  const runtimeProvider = providerLabel(runtimeIdentity.provider);
  const executionSummary = deriveIssueExecutionSummary({ issue, events, runs });
  const verifierReports = issueVerifierReports(events);
  const profileSummary = summarizeAgentProfile(project?.default_agent_profile);
  const mcpSummary = issueMcpRequirementSummary(issue);
  const latestRun = executionSummary.latestRun;
  const executionSessionRef = latestRun
    ? issueRunSessionRef(issue, latestRun)
    : runtimeIdentity.sessionId ? `codex:${runtimeIdentity.sessionId}` : '';
  const hasSupervisorHistory = supervisorHasSignal(supervisor);
  const hasCurrentSupervisorSignal = supervisorNeedsAttention(supervisor, issue);
  const renderTerminalLines = () => {
    // 将相邻的、类型相同的流式 delta 事件合并，解决单字符或短片段流式输出时高度折行、字占一行的排版问题
    const getMergedEvents = () => {
      const merged = [];
      for (const event of logEvents) {
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
        const status = issueStatusFromEvent(event) || 'unknown';
        const reason = payload.reason ? `（原因：${interruptReasonLabel(payload.reason)}）` : '';
        return (
          <div key={event.id || idx} className="terminal-line header">
            &gt;&gt; [{timestamp}] 系统状态变更为: {status.toUpperCase()}{reason}
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
      if (event.type === 'issue.interrupt_requested' || event.type === 'issue.interrupted' || event.type === 'issue.interrupt_failed') {
        const error = event.error || payload.error || '';
        return (
          <div key={event.id || idx} className={`terminal-line ${event.type === 'issue.interrupt_failed' ? 'error' : 'info'}`}>
            &gt;&gt; [{timestamp}] {interruptEventLabel(event.type)}；原因: {interruptReasonLabel(payload.reason)}；Thread: {payload.thread_id || event.threadId || '未知'}；Turn: {payload.turn_id || event.turnId || '未知'}{error ? `；错误: ${error}` : ''}
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
    <div className="issue-detail-page animate-fade-in">
      <div className="issue-detail-toolbar">
        <button className="issue-detail-back" type="button" onClick={() => navigateTo('issues')}>
          <ArrowLeft size={15} /> 返回队列
        </button>

        <div className="issue-detail-actions">
          {canEditIssue(issue) && (
            <button className="btn btn-secondary" type="button" onClick={() => setIsEditModalOpen(true)}>
              <Pencil size={14} /> 编辑任务
            </button>
          )}

          {canEditIssue(issue) && (
            <button className="btn btn-success" type="button" onClick={handleMoveToTodo}>
              <Play size={14} /> 移到 Todo
            </button>
          )}

          {(issue.status === 'todo' || issue.status === 'in_progress') && (
            <button className="btn btn-secondary issue-cancel-action" type="button" onClick={handleCancel}>
              <XOctagon size={14} /> {issue.status === 'in_progress' ? '中断执行' : '取消排队'}
            </button>
          )}

          {(issue.status === 'failed' || issue.status === 'cancelled' || issue.status === 'done') && (
            <button className="btn btn-primary" type="button" onClick={handleRetry}>
              <RotateCw size={14} /> 重新执行
            </button>
          )}

          <details className="issue-more-menu">
            <summary className="btn btn-secondary" aria-label="更多任务操作">
              <MoreHorizontal size={16} /> 更多 <ChevronDown size={13} />
            </summary>
            <div className="issue-more-menu-popover">
              <button type="button" onClick={() => setActiveTab('advanced')}>
                <Settings2 size={14} /> 高级信息与状态操作
              </button>
              {issue.status !== 'in_progress' && (
                <button type="button" className="danger" onClick={() => setDeleteConfirmOpen(true)}>
                  <Trash2 size={14} /> 删除 Issue
                </button>
              )}
            </div>
          </details>
        </div>
      </div>

      {deleteConfirmOpen && (
        <IssueDeleteConfirmModal
          issue={issue}
          deleting={deletingIssue}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={handleDelete}
        />
      )}

      {verificationReviewAction && (
        <VerificationReviewModal
          action={verificationReviewAction}
          draft={verificationReviewDraft}
          submitting={verificationReviewSubmitting}
          onDraftChange={setVerificationReviewDraft}
          onCancel={() => setVerificationReviewAction('')}
          onConfirm={() => handleVerificationReview(verificationReviewAction, verificationReviewDraft)}
        />
      )}

      <header className="issue-detail-hero glass-card">
        <div className="issue-detail-kicker">
          <span>{project ? project.name : issue.project_id}</span>
          <span>Issue #{issue.id}</span>
          <span>{formatRelativeTime(issue.updated_at)} 更新</span>
        </div>
        <div className="issue-detail-title-row">
          <div>
            <h1>{issue.title}</h1>
            <p>{issueStatusDescription(issue.status)}</p>
          </div>
          <span className={`status-badge ${issue.status} issue-detail-status`}>
            {issue.status === 'in_progress' && <span className="status-dot running" />}
            {issue.status}
          </span>
        </div>
      </header>

      <div className="issue-detail-overview-grid">
        <section className="issue-description-card glass-card">
          <div className="issue-section-heading">
            <div>
              <span className="issue-section-eyebrow">Task brief</span>
              <h2><FileText size={17} /> 任务说明</h2>
            </div>
            {canEditIssue(issue) && (
              <button className="kanban-card-action-btn" type="button" onClick={() => setIsEditModalOpen(true)}>
                <Pencil size={12} /> 编辑
              </button>
            )}
          </div>
          {issueBody ? (
            <div className="issue-description-content"><MarkdownPreview text={issueBody} /></div>
          ) : (
            <p className="issue-empty-copy">暂无任务描述。</p>
          )}
          {issue.source_session_id && (
            <div className="issue-source-strip">
              <div>
                <span>来源 Session</span>
                <strong>{issue.source_session_id}</strong>
                {issue.source_excerpt && <p>{summarize(issue.source_excerpt, 180)}</p>}
              </div>
              <button
                type="button"
                className="kanban-card-action-btn"
                onClick={() => navigateTo('sessions', null, issueSourceSessionRef(issue))}
              >
                <ExternalLink size={12} /> 查看来源
              </button>
            </div>
          )}
        </section>

        <IssueExecutionOverview
          issue={issue}
          latestRun={latestRun}
          summary={executionSummary}
          sessionRef={executionSessionRef}
          navigateTo={navigateTo}
        />
      </div>

      {executionSummary.statusConflict && (
        <div className="issue-inline-alert warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>状态需要核对</strong>
            <p>Issue 为 {issue.status}，最新 Run 为 {executionSummary.runStatus}。页面不再把历史 workflow 推断当作最终结论，请先查看 Session 或 Runs。</p>
          </div>
          <button type="button" onClick={() => setActiveTab('runs')}>查看 Runs</button>
        </div>
      )}

      {issue.error && issue.status !== 'pending_verification' && (
        <div className="issue-error-card issue-inline-alert danger" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>执行异常</strong>
            <p className="issue-error-text">{issue.error}</p>
          </div>
          <button type="button" onClick={() => setActiveTab('logs')}>查看日志</button>
        </div>
      )}

      {issue.status === 'pending_verification' && (
        <VerificationReviewPanel
          evidence={issue.error}
          onAccept={() => handleVerificationReview('accept', '')}
          onReject={() => setVerificationReviewAction('reject')}
          onRequestChanges={() => setVerificationReviewAction('request_changes')}
        />
      )}

      {hasCurrentSupervisorSignal && <IssueSupervisorPanel supervisor={supervisor} />}

      <section className="issue-detail-workspace glass-card">
        <div className="issue-detail-tabs" role="tablist" aria-label="Issue 详情分区">
          <IssueDetailTab
            active={activeTab === 'activity'}
            icon={<Activity size={15} />}
            label="活动"
            count={events.length}
            onClick={() => setActiveTab('activity')}
          />
          <IssueDetailTab
            active={activeTab === 'logs'}
            icon={<Terminal size={15} />}
            label="日志"
            count={logsLoaded ? logEvents.length : unseenLogCount}
            hasUpdate={!logsLoaded && unseenLogCount > 0}
            onClick={() => setActiveTab('logs')}
          />
          <IssueDetailTab
            active={activeTab === 'runs'}
            icon={<History size={15} />}
            label="Runs"
            count={runs.length}
            onClick={() => setActiveTab('runs')}
          />
          <IssueDetailTab
            active={activeTab === 'advanced'}
            icon={<Settings2 size={15} />}
            label="高级"
            onClick={() => setActiveTab('advanced')}
          />
        </div>

        <div className="issue-detail-tab-panel" role="tabpanel">
          {activeTab === 'activity' && (
            <div className="issue-activity-grid">
              <IssueActivityPanel events={events} />
              <IssueInternalNotes
                count={commentEvents.length}
                draft={commentDraft}
                error={commentError}
                submitting={commentSubmitting}
                sessionRef={executionSessionRef}
                navigateTo={navigateTo}
                onDraftChange={setCommentDraft}
                onSubmit={handleSubmitComment}
              />
            </div>
          )}

          {activeTab === 'logs' && (
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
                  {renderTerminalLines()}
                </div>
              )}
            </div>
          )}

          {activeTab === 'runs' && (
            <IssueRunsPanel
              issue={issue}
              project={project}
              profiles={profiles}
              runs={runs}
              currentStatus={issue.status}
              navigateTo={navigateTo}
              onCopy={handleCopyText}
            />
          )}

          {activeTab === 'advanced' && (
            <div className="issue-advanced-grid">
              <IssueMetadataPanel
                issue={issue}
                profileSummary={profileSummary}
                runtimeIdentity={runtimeIdentity}
                runtimeProvider={runtimeProvider}
                onServiceTierChange={handleServiceTierChange}
              />

              <IssueManualControls issue={issue} onMarkStatus={handleMarkStatus} />

              {hasMcpRequirements(mcpSummary) && <IssueMcpRequirementsPanel summary={mcpSummary} />}

              {hasSupervisorHistory && !hasCurrentSupervisorSignal && (
                <IssueSupervisorPanel supervisor={supervisor} />
              )}

              {canGenerateVerifierReport(issue) && (
                <VerifierReportPanel
                  reports={verifierReports}
                  generating={verifierGenerating}
                  error={verifierError}
                  onGenerate={handleGenerateVerifierReport}
                />
              )}
            </div>
          )}
        </div>
      </section>

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

function IssueExecutionOverview({ issue, latestRun, summary, sessionRef, navigateTo }) {
  const running = latestRun && !latestRun.ended_at;
  return (
    <section className="issue-execution-card glass-card">
      <div className="issue-section-heading">
        <div>
          <span className="issue-section-eyebrow">Execution truth</span>
          <h2><Activity size={17} /> 执行概览</h2>
        </div>
        {summary.statusConflict && <span className="issue-summary-flag warning">需核对</span>}
      </div>

      <div className="issue-execution-facts">
        <div>
          <span>Issue 状态</span>
          <strong>{summary.issueStatus}</strong>
        </div>
        <div>
          <span>最新 Run</span>
          <strong>
            {latestRun ? `#${latestRun.attempt || '?'} · ${summary.runStatus || 'unknown'}` : '尚未执行'}
            {running && <i className="status-dot running" />}
          </strong>
        </div>
        <div className={`issue-verification-fact ${summary.verification.state}`}>
          <span>结构化验证</span>
          <strong>{summary.verification.label}</strong>
          <p>{summary.verification.detail}</p>
        </div>
      </div>

      <div className="issue-next-action">
        <span>建议下一步</span>
        <p>{summary.nextAction}</p>
      </div>

      {sessionRef && (
        <button
          type="button"
          className="btn btn-primary issue-open-session"
          onClick={() => navigateTo?.('sessions', null, sessionRef)}
        >
          <ExternalLink size={14} /> 打开执行 Session
        </button>
      )}
      {!sessionRef && issue.status === 'triage' && (
        <p className="issue-empty-copy">任务尚未进入 runner，因此还没有执行 Session。</p>
      )}
    </section>
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

function IssueActivityPanel({ events }) {
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

function IssueInternalNotes({ count, draft, error, submitting, sessionRef, navigateTo, onDraftChange, onSubmit }) {
  return (
    <aside className="issue-notes-panel">
      <div className="issue-section-heading">
        <div>
          <span className="issue-section-eyebrow">Internal only · {count} notes</span>
          <h2><StickyNote size={17} /> 内部备注</h2>
        </div>
      </div>
      <div className="issue-notes-notice">
        <strong>不会发送给 Agent</strong>
        <p>这里仅写入 Issue 的活动审计，不会通知、恢复或 steer 正在运行的 Session。</p>
      </div>
      {sessionRef && (
        <button type="button" className="issue-session-link" onClick={() => navigateTo?.('sessions', null, sessionRef)}>
          <MessageCircle size={14} /> 要和 Agent 沟通？打开 Session <ExternalLink size={12} />
        </button>
      )}
      <form className="issue-note-form" onSubmit={onSubmit}>
        <textarea
          className="form-control"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="记录背景、验收口径或人工判断…"
          rows={5}
          disabled={submitting}
        />
        {error && <div className="issue-note-error">{error}</div>}
        <button type="submit" className="btn btn-secondary" disabled={submitting}>
          <Send size={14} /> {submitting ? '保存中…' : '保存内部备注'}
        </button>
      </form>
    </aside>
  );
}

function IssueMetadataPanel({ issue, profileSummary, runtimeIdentity, runtimeProvider, onServiceTierChange }) {
  return (
    <section className="issue-advanced-card">
      <div className="issue-section-heading">
        <div>
          <span className="issue-section-eyebrow">Runtime metadata</span>
          <h2><Settings2 size={17} /> 运行元数据</h2>
        </div>
      </div>
      <div className="issue-metadata-list">
        <MetadataRow label="当前状态" value={String(issue.status || 'unknown').toUpperCase()} />
        <MetadataRow label="尝试次数" value={`${issue.attempt_count || 0} 次`} />
        <MetadataRow label="优先级" value={issuePriorityLabel(issue.priority)} />
        <MetadataRow label="Provider" value={runtimeProvider} />
        <MetadataRow label="Agent Profile" value={profileSummary} />
        <MetadataRow label="Session ID" value={runtimeIdentity.sessionId || '未分配'} mono />
        <MetadataRow label="Turn ID" value={runtimeIdentity.turnId || '暂无'} mono />
        <MetadataRow label="创建时间" value={formatDateTime(issue.created_at)} />
        <MetadataRow label="最后更新" value={formatDateTime(issue.updated_at)} />
      </div>
      <label className="issue-service-tier-field">
        <span>下次运行速度</span>
        <select
          className="form-control"
          value={issue.service_tier || ''}
          onChange={(event) => onServiceTierChange(event.target.value)}
          disabled={issue.status === 'in_progress'}
        >
          {serviceTierOptions(issue.service_tier).map(option => (
            <option key={option.value || 'standard'} value={option.value}>{option.label}</option>
          ))}
        </select>
        <small>当前：{serviceTierLabel(issue.service_tier)}。运行中修改不会影响本轮快照。</small>
      </label>
    </section>
  );
}

function MetadataRow({ label, value, mono = false }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}

function IssueManualControls({ issue, onMarkStatus }) {
  return (
    <section className="issue-advanced-card issue-manual-controls">
      <div className="issue-section-heading">
        <div>
          <span className="issue-section-eyebrow">Manual override</span>
          <h2><UserCheck size={17} /> 人工状态干预</h2>
        </div>
      </div>
      <p>仅在运行态未正确回写时使用。此操作会直接改 Issue 状态，不会补造 Run 或验证证据。</p>
      <div>
        <button className="btn btn-secondary btn-success" type="button" disabled={issue.status === 'done'} onClick={() => onMarkStatus('done')}>
          <CheckCircle size={14} /> 标记 Done
        </button>
        <button className="btn btn-secondary btn-danger" type="button" disabled={issue.status === 'failed'} onClick={() => onMarkStatus('failed')}>
          <XCircle size={14} /> 标记 Failed
        </button>
      </div>
    </section>
  );
}

function IssueDeleteConfirmModal({ issue, deleting, onCancel, onConfirm }) {
  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content issue-delete-modal">
        <div className="issue-delete-modal-header">
          <Trash2 size={18} color="var(--error)" />
          <h3>删除 Issue #{issue.id}</h3>
        </div>
        <p className="issue-delete-modal-copy">
          将物理删除「{issue.title}」及其日志、运行记录和评论。此操作不可恢复。
        </p>
        <div className="issue-delete-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleting}>
            取消
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerificationReviewModal({ action, draft, submitting, onDraftChange, onCancel, onConfirm }) {
  const rejecting = action === 'reject';
  const title = rejecting ? '拒绝验证' : '请求修改';
  return (
    <div className="modal-overlay">
      <form
        className="glass-card modal-content verification-review-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="issue-delete-modal-header">
          <ClipboardCheck size={18} color="var(--primary)" />
          <h3>{title}</h3>
        </div>
        <p>这段说明会写入活动记录，并作为后续状态的人工依据。</p>
        <textarea
          className="form-control"
          rows={5}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={rejecting ? '说明拒绝原因…' : '说明需要修改的内容…'}
          autoFocus
          disabled={submitting}
        />
        <div className="issue-delete-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>取消</button>
          <button type="submit" className={rejecting ? 'btn btn-danger' : 'btn btn-primary'} disabled={submitting || !draft.trim()}>
            {submitting ? '提交中…' : `确认${title}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function IssueMcpRequirementsPanel({ summary }) {
  const active = hasMcpRequirements(summary);
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>MCP requirements</h3>
        <span className={`triage-readiness-badge ${summary.diagnostics.length ? 'refined' : active ? 'ready' : 'raw'}`}>
          {mcpRequirementStatus(summary)}
        </span>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.76rem', margin: 0 }}>
        这里只显示 issue/project/delegation 的 MCP capability 需求；不会直接执行 MCP。
      </p>
      <McpCapabilityGroup label="Required" items={summary.required} />
      <McpCapabilityGroup label="Recommended" items={summary.recommended} />
      <McpCapabilityGroup label="Project allowlist" items={summary.projectAllowed} />
      {summary.diagnostics.length > 0 && (
        <div style={{ color: 'var(--warning)', background: 'rgba(245,158,11,0.1)', padding: '8px 10px', borderRadius: '8px', fontSize: '0.78rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {summary.diagnostics.map((item, index) => (
            <span key={`${item.scope}-${item.capability_id}-${index}`}>
              <AlertTriangle size={13} /> {item.scope}: {item.capability_id} 未注册
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function McpCapabilityGroup({ label, items }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' }}>{label}</span>
      {items.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {items.map(item => <code key={item} style={{ fontSize: '0.72rem', background: 'rgba(0,0,0,0.08)', padding: '3px 6px', borderRadius: '6px' }}>{item}</code>)}
        </div>
      ) : (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>未声明</span>
      )}
    </div>
  );
}

function IssueRunsPanel({ issue, project, profiles, runs, currentStatus, navigateTo, onCopy }) {
  const latestRunId = latestRunFromRuns(runs)?.id || '';
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
            <IssueRunCard
              key={run.id}
              issue={issue}
              project={project}
              profiles={profiles}
              run={run}
              isLatest={run.id === latestRunId}
              navigateTo={navigateTo}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRunCard({ issue, project, profiles, run, isLatest, navigateTo, onCopy }) {
  const running = !run.ended_at;
  const error = run.error ? summarize(run.error, 160) : '';
  const sessionRef = issueRunSessionRef(issue, run);
  const sessionId = run.provider_session_id || run.codex_thread_id || issue?.codex_thread_id || '';
  const turnId = run.provider_turn_id || run.codex_turn_id || issue?.codex_turn_id || '';
  return (
    <article style={{ border: '1px solid var(--border-color)', borderRadius: '10px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>
          Attempt #{run.attempt}{isLatest ? ' · latest' : ''}
        </span>
        <span className={`status-badge ${run.status}`} style={{ fontSize: '0.72rem', padding: '3px 8px' }}>
          {running && <span className="status-dot running"></span>}
          {run.status}
        </span>
      </div>

      <RunField label="Run ID" value={run.id} mono />
      <RunField label="Provider" value={providerLabel(run.provider)} />
      <RunField label="Speed" value={serviceTierRunLabel(run)} />
      <RunField label="Agent Profile" value={issueRunProfileLabel(run, project, profiles)} />
      <RunField label="选择原因" value={runSelectionReasonLabel(run.selection_reason)} />
      <RunField label="Capabilities" value={runCapabilitySummary(run)} />
      <RunField label="Session" value={sessionId || '暂无'} mono />
      <RunField label="Turn" value={turnId || '暂无'} mono />
      <RunField label="开始" value={formatDateTime(run.started_at)} />
      <RunField label="结束" value={running ? '运行中' : formatDateTime(run.ended_at)} />
      {run.exit_reason && <RunField label="退出原因" value={run.exit_reason} />}
      {error && (
        <div style={{ color: 'var(--error)', background: 'var(--error-bg)', borderRadius: '8px', padding: '8px', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {sessionRef && (
          <button type="button" className="kanban-card-action-btn" onClick={() => navigateTo?.('sessions', null, sessionRef)}>
            <ExternalLink size={12} /> 打开 Session
          </button>
        )}
        <button type="button" className="kanban-card-action-btn" onClick={() => onCopy?.(runCopyText(run, sessionRef, sessionId, turnId))}>
          复制 Run
        </button>
      </div>
    </article>
  );
}

function latestRunFromRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce((latest, run) => Number(run.attempt || 0) >= Number(latest.attempt || 0) ? run : latest, runs[0]);
}

function runCopyText(run, sessionRef, sessionId, turnId) {
  return [
    `Run ID: ${run.id || ''}`,
    `Attempt: ${run.attempt || '?'}`,
    `Status: ${run.status || 'unknown'}`,
    `Provider: ${providerLabel(run.provider)}`,
    `Speed: ${serviceTierRunLabel(run)}`,
    `Agent Profile: ${run.agent_profile_id || 'none'}`,
    `Selection: ${run.selection_reason || 'none'}`,
    `Capabilities: ${runCapabilitySummary(run)}`,
    `Session: ${sessionRef || sessionId || 'none'}`,
    `Turn: ${turnId || 'none'}`,
    `Exit: ${run.error || run.exit_reason || 'none'}`,
  ].join('\n');
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

function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('当前浏览器不支持复制到剪贴板');
  return Promise.resolve();
}

function issueSourceSessionRef(issue) {
  const sessionId = String(issue?.source_session_id || '').trim();
  if (!sessionId) return '';
  return sessionId.startsWith('codex:') ? sessionId : `codex:${sessionId}`;
}

function summarize(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1)}…`;
}

function canGenerateVerifierReport(issue) {
  if (issue?.status === 'pending_verification') return true;
  return issue?.status === 'done' && String(issue?.error || '').trim() !== '';
}

function issueVerifierReports(events = []) {
  return events
    .filter(event => event.type === 'issue.verification_report')
    .map(event => ({ event, report: parseVerifierReportPayload(parseEventPayload(event)) }))
    .filter(item => item.report.summary || item.report.recommendation)
    .reverse();
}

function parseVerifierReportPayload(payload = {}) {
  return {
    summary: payload.summary || '',
    acceptanceChecklist: payload.acceptanceChecklist || payload.acceptance_checklist || '',
    evidenceFound: payload.evidenceFound || payload.evidence_found || '',
    evidenceMissing: payload.evidenceMissing || payload.evidence_missing || '',
    risk: payload.risk || '',
    recommendation: payload.recommendation || '',
    threadId: payload.thread_id || payload.threadId || '',
    turnId: payload.turn_id || payload.turnId || '',
  };
}

function VerifierReportPanel({ reports, generating, error, onGenerate }) {
  const latest = reports[0];
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderLeft: '4px solid #06b6d4' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ClipboardCheck size={18} color="#06b6d4" /> Verifier report
          </h3>
          <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            只读审查最新 run、事件、证据和 diff 摘要；只给建议，不会自动改最终状态。
          </p>
        </div>
        <button className="btn btn-primary" style={{ padding: '7px 10px', fontSize: '0.78rem' }} onClick={onGenerate} disabled={generating}>
          <RotateCw size={14} /> {generating ? '生成中...' : '生成 report'}
        </button>
      </div>
      {error && (
        <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 10px', borderRadius: '6px', fontSize: '0.78rem' }}>
          {error}
        </div>
      )}
      {latest ? (
        <VerifierReportCard item={latest} />
      ) : (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0 }}>
          暂无 verifier report，可先生成一份再人工 Accept / Reject / Request changes。
        </p>
      )}
    </section>
  );
}

function VerifierReportCard({ item }) {
  const report = item.report;
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`triage-readiness-badge ${verifierRecommendationClass(report.recommendation)}`}>
          Recommendation: {report.recommendation || 'unknown'}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{formatDateTime(item.event.created_at)}</span>
      </div>
      <VerifierReportSection title="Summary" value={report.summary} />
      <VerifierReportSection title="Acceptance checklist" value={report.acceptanceChecklist} />
      <VerifierReportSection title="Evidence found" value={report.evidenceFound} />
      <VerifierReportSection title="Evidence missing" value={report.evidenceMissing} />
      <VerifierReportSection title="Risk" value={report.risk} />
      {(report.threadId || report.turnId) && (
        <code style={{ color: 'var(--text-muted)', fontSize: '0.7rem', overflowWrap: 'anywhere' }}>
          Verifier: {report.threadId || 'thread?'} / {report.turnId || 'turn?'}
        </code>
      )}
    </article>
  );
}

function VerifierReportSection({ title, value }) {
  if (!value) return null;
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px', background: 'rgba(6,182,212,0.06)', minWidth: 0 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>{title}</div>
      <MarkdownPreview text={value} />
    </div>
  );
}

function verifierRecommendationClass(recommendation) {
  if (recommendation === 'accept') return 'ready';
  if (recommendation === 'reject') return 'raw';
  return 'refined';
}

function VerificationReviewPanel({ evidence, onAccept, onReject, onRequestChanges }) {
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderLeft: '4px solid #8b5cf6' }}>
      <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <UserCheck size={18} color="#8b5cf6" /> 待验证门禁
      </h3>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        Agent 已提交完成证据，等待人工或 verifier 确认；接受后进入 Done，拒绝后进入 Failed，要求修改会退回 Triage。
      </p>
      {evidence && (
        <div className="issue-error-text" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: '8px', padding: '10px', fontSize: '0.78rem' }}>
          {evidence}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button className="btn btn-secondary btn-success" onClick={onAccept}>
          <CheckCircle size={14} /> Accept → Done
        </button>
        <button className="btn btn-secondary btn-danger" onClick={onReject}>
          <XCircle size={14} /> Reject → Failed
        </button>
        <button className="btn btn-secondary" onClick={onRequestChanges}>
          <MessageCircle size={14} /> Request changes → Triage
        </button>
      </div>
    </section>
  );
}

function supervisorHasSignal(supervisor) {
  const latest = supervisor?.latest || {};
  const decision = latest.pi_decision || {};
  return Boolean(
    latest.diagnosis_code
      || decision.decision
      || supervisor?.retry_after
      || latest.provider_error?.raw_summary
      || (Array.isArray(supervisor?.recovery_history) && supervisor.recovery_history.length > 0)
  );
}

function supervisorNeedsAttention(supervisor, issue) {
  if (!ACTIVE_SUPERVISOR_STATUSES.has(issue?.status)) return false;
  const latest = supervisor?.latest || {};
  const decision = latest.pi_decision?.decision || '';
  const diagnosis = String(latest.diagnosis_code || '');
  return decision === 'needs_user'
    || decision === 'blocked'
    || Number(supervisor?.retry_after?.remaining_seconds || 0) > 0
    || diagnosis === 'provider_retry_after_waiting';
}

function issuePriorityLabel(value) {
  const priority = Number(value);
  if (priority === 2) return 'High · 紧急';
  if (priority === 1) return 'Medium · 普通';
  if (priority === 0) return 'Low · 低';
  return Number.isFinite(priority) ? `Legacy rank · ${priority}` : '未设置';
}

function issueStatusDescription(status) {
  switch (status) {
    case 'triage': return '待梳理任务说明，尚未进入 runner 队列。';
    case 'todo': return '已进入执行队列，等待 runner claim。';
    case 'in_progress': return 'Provider 正在执行，实时交互请进入 Session。';
    case 'pending_verification': return '执行已结束，等待人工完成验证门禁。';
    case 'done': return '任务已结束；请结合 Run 与结构化验证证据判断结果。';
    case 'failed': return '最近一次执行失败，可从日志或 Session 定位退出原因。';
    case 'cancelled': return '任务已取消，可在确认上下文后重新执行。';
    default: return '查看活动记录和运行信息确认当前状态。';
  }
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '未知时间';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`;
  return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前`;
}
