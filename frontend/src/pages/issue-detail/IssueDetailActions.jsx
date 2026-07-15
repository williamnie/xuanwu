import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  Settings2,
  Trash2,
  UserCheck,
  XCircle,
  XOctagon,
} from 'lucide-react';
import { canEditIssue } from '../../utils/issueEdit';

export default function IssueDetailActions({
  issue,
  onBack,
  onEdit,
  onMoveToTodo,
  onCancel,
  onRetry,
  onShowAdvanced,
  onDelete,
}) {
  return (
    <div className="issue-detail-toolbar">
      <button className="issue-detail-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> 返回队列
      </button>

      <div className="issue-detail-actions">
        {canEditIssue(issue) && (
          <button className="btn btn-secondary" type="button" onClick={onEdit}>
            <Pencil size={14} /> 编辑任务
          </button>
        )}

        {canEditIssue(issue) && (
          <button className="btn btn-success" type="button" onClick={onMoveToTodo}>
            <Play size={14} /> 移到 Todo
          </button>
        )}

        {(issue.status === 'todo' || issue.status === 'in_progress') && (
          <button className="btn btn-secondary issue-cancel-action" type="button" onClick={onCancel}>
            <XOctagon size={14} /> {issue.status === 'in_progress' ? '中断执行' : '取消排队'}
          </button>
        )}

        {(issue.status === 'failed' || issue.status === 'cancelled' || issue.status === 'done') && (
          <button className="btn btn-primary" type="button" onClick={onRetry}>
            <RotateCw size={14} /> 重新执行
          </button>
        )}

        <details className="issue-more-menu">
          <summary className="btn btn-secondary" aria-label="更多任务操作">
            <MoreHorizontal size={16} /> 更多 <ChevronDown size={13} />
          </summary>
          <div className="issue-more-menu-popover">
            <button type="button" onClick={onShowAdvanced}>
              <Settings2 size={14} /> 高级信息与状态操作
            </button>
            {issue.status !== 'in_progress' && (
              <button type="button" className="danger" onClick={onDelete}>
                <Trash2 size={14} /> 删除 Issue
              </button>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

export function IssueManualControls({ issue, onMarkStatus }) {
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

export function IssueDeleteConfirmModal({ issue, deleting, onCancel, onConfirm }) {
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
