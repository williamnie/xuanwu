import { useCallback, useEffect, useState } from 'react';
import { workApi } from '../../api/work.js';
import { message } from '../../store/toastStore';
import { selectRefreshData, useDataStore } from '../../store/dataStore';
import { hasIssueEvent } from '../../utils/stateGuards';
import { serviceTierPayload } from '../../utils/serviceTier';
import { copyTextToClipboard } from './issueDetailFormatters';

export default function useIssueDetailActions({
  issueId,
  issue,
  navigateTo,
  loadIssueData,
  updateDetailState,
}) {
  const refreshData = useDataStore(selectRefreshData);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentError, setCommentError] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [humanReviewAction, setHumanReviewAction] = useState('');
  const [humanReviewDraft, setHumanReviewDraft] = useState('');
  const [humanReviewSubmitting, setHumanReviewSubmitting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingIssue, setDeletingIssue] = useState(false);

  useEffect(() => {
    setIsEditModalOpen(false);
    setCommentDraft('');
    setCommentError('');
    setCommentSubmitting(false);
    setHumanReviewAction('');
    setHumanReviewDraft('');
    setHumanReviewSubmitting(false);
    setDeleteConfirmOpen(false);
    setDeletingIssue(false);
  }, [issueId]);

  const handleMoveToTodo = async () => {
    try {
      await workApi.updateIssue(issueId, { status: 'todo', ...serviceTierPayload(issue.service_tier) });
      message.success('Issue 已移动到 Todo');
      loadIssueData();
    } catch (err) {
      message.error('移动到 Todo 失败: ' + err.message);
    }
  };

  const handleRetry = async () => {
    try {
      await workApi.retryIssue(issueId, serviceTierPayload(issue.service_tier));
      updateDetailState(draft => {
        draft.logEvents = [];
        draft.logsLoaded = false;
        draft.logsHasMore = false;
        draft.unseenLogCount = 0;
      });
      loadIssueData();
    } catch (err) {
      message.error('重新运行失败: ' + err.message);
    }
  };

  const handleServiceTierChange = async (serviceTier) => {
    try {
      const updated = await workApi.updateIssue(issueId, serviceTierPayload(serviceTier));
      updateDetailState(draft => {
        draft.issue = updated;
      });
      refreshData(['issues']);
    } catch (err) {
      message.error('更新执行速度失败: ' + err.message);
    }
  };

  const handleIssueLogModeChange = async (issueLogMode) => {
    try {
      const updated = await workApi.updateIssue(issueId, { issue_log_mode: issueLogMode });
      updateDetailState(draft => {
        draft.issue = updated;
      });
      message.success(issueLogMode === 'debug' ? '下次运行将记录完整调试日志' : '已恢复精简日志模式');
      refreshData(['issues']);
    } catch (err) {
      message.error('更新日志模式失败: ' + err.message);
    }
  };

  const handleCancel = async () => {
    try {
      await workApi.cancelIssue(issueId);
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
      await workApi.deleteIssue(issueId);
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
      await workApi.updateIssue(issueId, { status: targetStatus });
      loadIssueData();
    } catch (err) {
      message.error('更改状态失败: ' + err.message);
    }
  };

  const handleHumanReviewResponse = async (action, comment = '') => {
    setHumanReviewSubmitting(true);
    try {
      await workApi.answerIssueHumanReview(issueId, {
        action,
        comment: comment.trim(),
        review_request_id: issue?.decision?.request?.id,
        review_revision: issue?.decision?.request?.revision,
      });
      message.success('回答已提交，PI 将继续判断');
      setHumanReviewAction('');
      setHumanReviewDraft('');
      loadIssueData();
      refreshData(['issues']);
    } catch (err) {
      message.error('提交人工回答失败: ' + err.message);
    } finally {
      setHumanReviewSubmitting(false);
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
      const created = await workApi.createIssueComment(issueId, { body, author: 'user' });
      updateDetailState(draft => {
        if (!hasIssueEvent(draft.events, created)) draft.events.push(created);
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

  const closeEditModal = useCallback(() => setIsEditModalOpen(false), []);
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

  return {
    isEditModalOpen,
    setIsEditModalOpen,
    commentDraft,
    setCommentDraft,
    commentError,
    commentSubmitting,
    humanReviewAction,
    setHumanReviewAction,
    humanReviewDraft,
    setHumanReviewDraft,
    humanReviewSubmitting,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    deletingIssue,
    handleMoveToTodo,
    handleRetry,
    handleServiceTierChange,
    handleIssueLogModeChange,
    handleCancel,
    handleDelete,
    handleMarkStatus,
    handleHumanReviewResponse,
    handleSubmitComment,
    closeEditModal,
    handleIssueSaved,
    handleCopyText,
  };
}
