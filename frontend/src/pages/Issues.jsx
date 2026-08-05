import { workApi } from '../api/work.js';
import { projectsApi } from '../api/projects.js';
import { useEffect, useState } from 'react';
import { message } from '../store/toastStore';
import {
  selectIssues,
  selectProjects,
  selectRefreshData,
  useDataStore,
} from '../store/dataStore';
import {
  Plus,
  X,
  Sparkles,
  Trash2,
} from 'lucide-react';
import PromptEditor from '../components/editor/PromptEditor';
import IssueEditModal from '../components/IssueEditModal';
import IssueCard from './IssueCard';
import { sortIssuesByIdDesc } from '../utils/issueSort';
import { serviceTierPayload } from '../utils/serviceTier';

export default function Issues({
  filterProject,
  focusFilter,
  isNewIssueOpen,
  setIsNewIssueOpen,
  prefilledStatus,
  sourceMetadata,
  handleOpenNewIssue,
  navigateTo,
}) {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
  const refreshData = useDataStore(selectRefreshData);

  // 新建 Issue 的局部表单状态
  const [formDescription, setFormDescription] = useState('');
  const [formProjectId, setFormProjectId] = useState(projects[0]?.id || '');
  const [formPriority, setFormPriority] = useState(0);
  const [formAgentProfileId, setFormAgentProfileId] = useState('');
  const [agentProfiles, setAgentProfiles] = useState([]);
  const [agentProfilesLoading, setAgentProfilesLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 拖拽相关的局部交互状态
  const [draggingIssueId, setDraggingIssueId] = useState(null);
  const [draggedOverColumnId, setDraggedOverColumnId] = useState(null);
  const [retryingIssueId, setRetryingIssueId] = useState(null);
  const [issueToDelete, setIssueToDelete] = useState(null);
  const [issueToEdit, setIssueToEdit] = useState(null);
  const [deletingIssueId, setDeletingIssueId] = useState(null);
  const [pendingServiceTiers, setPendingServiceTiers] = useState({});

  const stopCardAction = (event) => {
    event.stopPropagation();
  };

  const handleRetryIssue = async (event, issue) => {
    stopCardAction(event);
    const issueId = issue?.id;
    if (!issueId) return;
    setRetryingIssueId(issueId);
    try {
      await workApi.retryIssue(issueId, serviceTierPayload(issue?.service_tier));
      message.success(`Issue #${issueId} 已重新加入队列`);
      refreshData(['issues']);
    } catch (err) {
      message.error(`重新执行失败: ${err.message || '网络异常'}`);
    } finally {
      setRetryingIssueId(null);
    }
  };

  const handleIssueServiceTierChange = async (event, issueId, serviceTier) => {
    stopCardAction(event);
    setPendingServiceTiers(prev => ({ ...prev, [issueId]: serviceTier }));
    try {
      await workApi.updateIssue(issueId, serviceTierPayload(serviceTier));
      await refreshData(['issues']);
    } catch (err) {
      message.error(`更新执行速度失败: ${err.message || '网络异常'}`);
    } finally {
      setPendingServiceTiers(prev => omitKey(prev, issueId));
    }
  };

  const handleOpenSession = (event, sessionRef) => {
    stopCardAction(event);
    if (sessionRef) {
      navigateTo('sessions', null, sessionRef);
    }
  };

  const handleRequestDeleteIssue = (event, issue) => {
    stopCardAction(event);
    if (issue.status === 'in_progress') {
      message.warning('运行中的 Issue 不能删除，请先中断取消');
      return;
    }
    setIssueToDelete(issue);
  };

  const handleRequestEditIssue = (event, issue) => {
    stopCardAction(event);
    setIssueToEdit(issue);
  };

  const handleIssueSaved = async () => {
    setIssueToEdit(null);
    await refreshData(['issues']);
    message.success('Issue 已保存');
  };

  const handleConfirmDeleteIssue = async () => {
    if (!issueToDelete) return;
    setDeletingIssueId(issueToDelete.id);
    try {
      await workApi.deleteIssue(issueToDelete.id);
      message.success(`Issue #${issueToDelete.id} 已删除`);
      setIssueToDelete(null);
      refreshData(['issues']);
    } catch (err) {
      message.error(`删除失败: ${err.message || '网络异常'}`);
    } finally {
      setDeletingIssueId(null);
    }
  };


  // 拖拽开始：记录被拖拽的任务 ID 与当前状态，并设置拖拽状态
  const handleDragStart = (e, issueId, currentStatus) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ issueId, currentStatus }));
    e.dataTransfer.effectAllowed = 'move';
    // 在下一个宏任务或微任务中设置正在拖动的样式，保证拖动时半透明卡片阴影生成不受影响
    setTimeout(() => {
      setDraggingIssueId(issueId);
    }, 0);
  };

  // 拖拽结束：清理卡片拖拽状态
  const handleDragEnd = () => {
    setDraggingIssueId(null);
    setDraggedOverColumnId(null);
  };

  // 拖拽悬停列上：允许 drop，并记录被悬停的列 ID
  const handleDragOver = (e, columnId) => {
    e.preventDefault();
    if (draggedOverColumnId !== columnId) {
      setDraggedOverColumnId(columnId);
    }
  };

  // 拖拽离开列：清除被悬停列 ID
  const handleDragLeave = (e, columnId) => {
    if (draggedOverColumnId === columnId) {
      setDraggedOverColumnId(null);
    }
  };

  // 拖拽释放：处理状态更改 API 调用
  const handleDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDraggedOverColumnId(null);
    setDraggingIssueId(null);

    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;

    try {
      const { issueId, currentStatus } = JSON.parse(dataStr);

      if (currentStatus === targetStatus) {
        return;
      }

      await moveIssueAfterDrop(issueId, currentStatus, targetStatus);

      // 成功后重新加载数据，保证即时同步
      refreshData(['issues']);
    } catch (err) {
      console.error('更新 Issue 状态失败:', err);
      message.error(`更改状态失败: ${err.message || '网络异常'}`);
    }
  };

  const moveIssueAfterDrop = async (issueId, currentStatus, targetStatus) => {
    if (targetStatus === 'in_progress') {
      await workApi.enqueueIssue(issueId);
      message.success(`Issue #${issueId} 已加入执行队列`);
      return;
    }
    if (currentStatus === 'in_progress' && targetStatus === 'todo') {
      await workApi.retryIssue(issueId);
      message.success(`Issue #${issueId} 的旧 Session 已中断并重新排队`);
      return;
    }
    await workApi.updateIssue(issueId, { status: targetStatus });
  };

  // 当模态框打开时重置表单输入内容，防止共享项目列表更新时清空用户输入
  useEffect(() => {
    if (isNewIssueOpen) {
      refreshData(['projects']);
      setFormDescription(sourceMetadata?.source_excerpt || '');
      setFormPriority(0);
      setFormAgentProfileId('');
      setFormError('');
      setAgentProfilesLoading(true);
      projectsApi.getAgentProfiles()
        .then((items) => setAgentProfiles(Array.isArray(items) ? items : items?.items || []))
        .catch((error) => setFormError(error.message || 'Agent Profiles 加载失败'))
        .finally(() => setAgentProfilesLoading(false));
    }
  }, [isNewIssueOpen, refreshData, sourceMetadata]);

  // 当模态框打开或者项目列表变化时，同步关联项目 ID，但不影响已输入内容和用户手动选择
  useEffect(() => {
    if (isNewIssueOpen) {
      setFormProjectId(prev => {
        if (projects && projects.length > 0) {
          const sourceProjectId = sourceMetadata?.project_id || '';
          if (sourceProjectId && projects.some(p => p.id === sourceProjectId)) {
            return sourceProjectId;
          }
          if (prev && projects.some(p => p.id === prev)) {
            return prev;
          }
          return projects[0].id;
        }
        return '';
      });
    }
  }, [isNewIssueOpen, projects, sourceMetadata]);

  // 相对时间计算函数，完美还原截图如 "19h"、"2d" 等显示
  const getRelativeTime = (dateStr) => {
    if (!dateStr) return '0m';
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now - date;

    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    return `${days}d`;
  };

  const handleCreateIssue = async (e) => {
    e.preventDefault();
    if (!formDescription.trim()) {
      setFormError('任务内容不能为空');
      return;
    }
    const finalProjectId = formProjectId || (projects[0]?.id || '');
    if (!finalProjectId) {
      setFormError('请先创建项目');
      return;
    }

    setSubmitting(true);
    setFormError('');

    const payload = {
      description: formDescription.trim(),
      project_id: finalProjectId,
      priority: parseInt(formPriority),
      status: prefilledStatus || 'triage',
      agent_profile_id: formAgentProfileId,
    };
    addIssueSource(payload, sourceMetadata);

    try {
      await workApi.createIssue(payload);
      setIsNewIssueOpen(false);
      setFormDescription('');
      refreshData(['issues']);
    } catch (err) {
      setFormError(err.message || '新建 Issue 失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 1. 过滤当前项目的 Issue 列表
  const projectIssues = sortIssuesByIdDesc(
    issues.filter(i => !filterProject || i.project_id === filterProject)
  );

  // 2. 将 Issue 数据按照看板状态分类
  const triageIssues = projectIssues.filter(i => i.status === 'triage');
  const todoIssues = projectIssues.filter(i => i.status === 'todo');
  const inProgressIssues = projectIssues.filter(i => i.status === 'in_progress');
  const failedIssues = projectIssues.filter(i => i.status === 'failed');
  const doneIssues = projectIssues.filter(i => i.status === 'done');
  const cancelledIssues = projectIssues.filter(i => i.status === 'cancelled');

  // 3. 看板列配置
  const columns = [
    {
      id: 'triage',
      title: 'Triage',
      dotColor: '#fbbf24', // 黄色
      emptyText: 'no agent-filed issues waiting',
      issues: triageIssues
    },
    {
      id: 'todo',
      title: 'Todo',
      dotColor: '#64748b', // 灰色
      emptyText: 'nothing queued',
      issues: todoIssues
    },
    {
      id: 'in_progress',
      title: 'In Progress',
      dotColor: '#3b82f6', // 蓝色
      emptyText: 'nothing in flight',
      issues: inProgressIssues
    },
    {
      id: 'failed',
      title: 'Failed',
      dotColor: '#ef4444', // 红色
      emptyText: 'nothing failed',
      issues: failedIssues
    },
    {
      id: 'done',
      title: 'Done',
      dotColor: '#10b981', // 绿色
      emptyText: 'nothing completed',
      issues: doneIssues
    },
    {
      id: 'cancelled',
      title: 'Cancelled',
      dotColor: '#ef4444', // 红色
      emptyText: 'nothing cancelled',
      issues: cancelledIssues
    }
  ];

  // 4. 根据侧边栏 FOCUS 过滤器决定渲染哪些列
  const getVisibleColumns = () => {
    switch (focusFilter) {
      case 'triage':
        return columns.filter(c => c.id === 'triage');
      case 'active':
        return columns.filter(c => c.id === 'todo' || c.id === 'in_progress');
      case 'failed':
        return columns.filter(c => c.id === 'failed');
      case 'archive':
        return columns.filter(c => c.id === 'done' || c.id === 'cancelled');
      case 'all':
      default:
        return columns;
    }
  };

  const visibleColumns = getVisibleColumns();
  return (
    <div className="issues-page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}>

      {/* 头部控制栏 (对齐截图) */}
      <div className="view-header">
        <h1 className="view-title">
          Issues <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 500 }}>— {projectIssues.length}</span>
        </h1>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            style={{ padding: '6px 12px', fontSize: '0.78rem' }}
            onClick={() => handleOpenNewIssue('todo')}
          >
            <Plus size={14} /> New issue
          </button>
        </div>
      </div>


      {/* 核心看板网格组件 */}
      <div className="kanban-board">
        {visibleColumns.map(col => (
          <div
            key={col.id}
            className={`kanban-column ${draggedOverColumnId === col.id ? 'drag-over' : ''}`}
            onDragOver={(e) => handleDragOver(e, col.id)}
            onDragLeave={(e) => handleDragLeave(e, col.id)}
            onDrop={(e) => handleDrop(e, col.id)}
          >

            {/* 列头部 */}
            <div className="kanban-column-header">
              <div className="kanban-column-title">
                <span className="kanban-column-dot" style={{ background: col.dotColor }}></span>
                <span>{col.title}</span>
                <span className="kanban-column-count">{col.issues.length}</span>
              </div>
              <button
                className="kanban-column-add-btn"
                onClick={() => handleOpenNewIssue(col.id === 'cancelled' ? 'cancelled' : col.id)}
                title={`添加新任务到 ${col.title}`}
              >
                <Plus size={14} />
              </button>
            </div>

            {/* 卡片容器 */}
            <div className="kanban-cards-container">
              {col.issues.length === 0 ? (
                <div className="kanban-column-empty">
                  {col.emptyText}
                </div>
              ) : (
                col.issues.map(issue => {
                  const proj = projects.find(p => p.id === issue.project_id);
                  const cardIssue = issueWithPendingServiceTier(issue, pendingServiceTiers);
                  return (
                    <IssueCard
                      key={issue.id}
                      issue={cardIssue}
                      project={proj}
                      dragging={draggingIssueId === issue.id}
                      retrying={retryingIssueId === issue.id}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      onOpenIssue={(issueId) => navigateTo('issues', issueId)}
                      onOpenSession={handleOpenSession}
                      onRequestDelete={handleRequestDeleteIssue}
                      onRequestEdit={handleRequestEditIssue}
                      onRetry={handleRetryIssue}
                      onServiceTierChange={handleIssueServiceTierChange}
                      getRelativeTime={getRelativeTime}
                    />
                  );
                })
              )}
            </div>

          </div>
        ))}
      </div>

      {/* 新建 Issue 高级模态框 (完美融合) */}
      {isNewIssueOpen && (
        <div className="modal-overlay">
          <div className="glass-card modal-content" style={{ maxWidth: '760px', padding: '24px' }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={16} color="var(--primary)" /> 创建新 Issue ({prefilledStatus.toUpperCase()})
              </h3>
              <button
                style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                onClick={() => setIsNewIssueOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateIssue} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

              {formError && (
                <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 12px', borderRadius: '4px', fontSize: '0.78rem' }}>
                  {formError}
                </div>
              )}

              {projects.length === 0 ? (
                <div style={{ color: 'var(--warning)', background: 'var(--warning-bg)', padding: '10px 14px', borderRadius: '6px', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                  <strong style={{ fontWeight: 600 }}>暂无项目可关联</strong>
                  <span>请先前往「Projects」项目管理页面新增监控项目，然后再在此创建任务。</span>
                </div>
              ) : (
                <div className="form-group">
                  <label>关联目标项目 *</label>
                  <select
                    className="form-control"
                    value={formProjectId}
                    onChange={(e) => setFormProjectId(e.target.value)}
                    required
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {sourceMetadata?.source_session_id && (
                <div style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: '6px', fontSize: '0.78rem', border: '1px solid var(--border-color)' }}>
                  来源 Session：<code>{sourceMetadata.source_session_id}</code>
                  {sourceMetadata.source_turn_id && <> · Turn：<code>{sourceMetadata.source_turn_id}</code></>}
                </div>
              )}

              <div className="form-group">
                <label>Code Agent</label>
                <select
                  className="form-control"
                  value={formAgentProfileId}
                  onChange={(event) => setFormAgentProfileId(event.target.value)}
                  disabled={agentProfilesLoading}
                >
                  <option value="">继承项目默认 Provider</option>
                  {agentProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {codeAgentLabel(profile.provider)} · {profile.name} · {profile.model || 'default'}
                    </option>
                  ))}
                </select>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  可为单个工作项显式选择 Code Agent；未选择时沿用项目默认配置。
                </span>
              </div>

              <div className="form-group">
                <label>任务内容 / 需求描述 *</label>
                <PromptEditor
                  placeholder="直接写要 Codex 处理的完整内容，例如复现路径、报错日志、期望改动和验证方式..."
                  value={formDescription}
                  onChange={setFormDescription}
                  minHeight={180}
                  variant="composer"
                />
              </div>

              <div className="form-group">
                <label>任务优先级</label>
                <select
                  className="form-control"
                  value={formPriority}
                  onChange={(e) => setFormPriority(e.target.value)}
                >
                  <option value={0}>普通优先级</option>
                  <option value={1}>中优先级</option>
                  <option value={2}>紧急插队 (High)</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setIsNewIssueOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px' }} disabled={submitting || projects.length === 0}>
                  {submitting ? '创建中...' : '提交创建'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

      {issueToDelete && (
        <IssueDeleteConfirmModal
          issue={issueToDelete}
          deleting={deletingIssueId === issueToDelete.id}
          onCancel={() => setIssueToDelete(null)}
          onConfirm={handleConfirmDeleteIssue}
        />
      )}

      {issueToEdit && (
        <IssueEditModal
          issue={issueToEdit}
          onClose={() => setIssueToEdit(null)}
          onSaved={handleIssueSaved}
        />
      )}

    </div>
  );
}

function codeAgentLabel(provider) {
  if (provider === 'claude') return 'Claude Code';
  if (provider === 'pi-coding-agent') return 'Pi';
  return provider || 'Code Agent';
}

function issueWithPendingServiceTier(issue, pendingServiceTiers) {
  if (!Object.hasOwn(pendingServiceTiers, issue.id)) return issue;
  return { ...issue, service_tier: pendingServiceTiers[issue.id] };
}

function omitKey(record, key) {
  const next = { ...record };
  delete next[key];
  return next;
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

function addIssueSource(payload, sourceMetadata) {
  if (!sourceMetadata?.source_session_id) return;
  payload.source_session_id = sourceMetadata.source_session_id;
  if (sourceMetadata.source_turn_id) {
    payload.source_turn_id = sourceMetadata.source_turn_id;
  }
  if (sourceMetadata.source_excerpt) {
    payload.source_excerpt = sourceMetadata.source_excerpt;
  }
}
