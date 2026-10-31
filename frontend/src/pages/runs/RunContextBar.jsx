import { runPhaseLabel } from './runPhaseLabels.js';
import { useState } from 'react';
import { ArrowUpRight, CircleStop, Play, RotateCcw } from 'lucide-react';
import { runsApi } from '../../api/runs.js';
import { message as toast } from '../../store/toastStore';
import {
  buildRunControlPayload,
  runAvailableActions,
  runIssueId,
  runStatusLabel,
  providerLabel,
} from './runPageModel.js';

// 执行记录页与任务详情共用的执行头部：状态、所属任务与受审计的中断 / 继续 / 重试。
// 任务已有任务级“重试”时由调用方关闭执行级重试，避免同屏出现两个含义不同的重试。
export default function RunContextBar({ allowRetry = true, navigateTo, onRunChanged, run, showWorkLink = true }) {
  const [pendingAction, setPendingAction] = useState('');
  const [resumePrompt, setResumePrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const actions = runAvailableActions(run);
  const issueId = runIssueId(run);

  const controlRun = async (action) => {
    if (submitting || (action === 'resume' && !resumePrompt.trim())) return;
    setSubmitting(true);
    try {
      const eventId = `runs-ui:${action}:${randomEventId()}`;
      const response = await runsApi.controlRun(run.id, action, buildRunControlPayload(run, action, {
        eventId,
        prompt: resumePrompt,
      }));
      onRunChanged(response.run);
      setPendingAction('');
      setResumePrompt('');
      toast.success(action === 'interrupt' ? '已请求中断这次执行' : action === 'resume' ? '已提交继续执行的指令' : '已请求重新执行');
    } catch (controlError) {
      toast.error(controlError.message || '执行操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="run-context-bar">
      <div className="run-context-main">
        <div className="run-context-title-row">
          <span className={`run-context-status ${run.status || 'unknown'}`}>{runStatusLabel(run.status)}</span>
          <strong>{showWorkLink ? run.work_title || '未命名任务' : `第 ${run.sequence || '?'} 次执行`}</strong>
          {showWorkLink && run.work_id ? (
            <button className="run-work-link" onClick={() => navigateTo?.('tasks', run.work_id, '', '', { runId: run.id })} type="button">
              所属任务{issueId ? ` #${issueId}` : ''} <ArrowUpRight size={13} />
            </button>
          ) : null}
        </div>
        <div className="run-context-meta">
          <span>{providerLabel(run.provider)}</span>
          {showWorkLink ? <span>第 {run.sequence || '?'} 次执行</span> : null}
          <span>尝试 {run.progress?.attempt_sequence || run.attempt_count || '?'}</span>
          <span>阶段：{runPhaseLabel(run.progress?.provider_phase || run.progress?.phase)}</span>
          {run.progress?.stalled?.detected ? <span className="run-context-warning">可能卡住</span> : null}
        </div>
      </div>

      <div className="run-context-actions">
        {actions.interrupt ? (
          <button onClick={() => setPendingAction('interrupt')} type="button"><CircleStop size={13} /> 中断</button>
        ) : null}
        {actions.resume ? (
          <button onClick={() => setPendingAction('resume')} type="button"><Play size={13} /> 继续</button>
        ) : null}
        {allowRetry && actions.retry ? (
          <button onClick={() => setPendingAction('retry')} type="button"><RotateCcw size={13} /> 重试</button>
        ) : null}
      </div>

      {pendingAction ? (
        <div className="run-control-confirm" role="group" aria-label={`确认${actionLabel(pendingAction)}`}>
          {pendingAction === 'resume' ? (
            <textarea
              autoFocus
              onChange={event => setResumePrompt(event.target.value)}
              placeholder="输入继续这次执行的指令"
              rows={2}
              value={resumePrompt}
            />
          ) : (
            <span>确认{pendingAction === 'interrupt' ? '中断当前尝试' : '重新执行'}？操作会写入审计记录。</span>
          )}
          <div>
            <button disabled={submitting} onClick={() => setPendingAction('')} type="button">取消</button>
            <button
              className="run-control-primary"
              disabled={submitting || (pendingAction === 'resume' && !resumePrompt.trim())}
              onClick={() => controlRun(pendingAction)}
              type="button"
            >
              {submitting ? '提交中…' : '确认提交'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function actionLabel(action) {
  return action === 'interrupt' ? '中断' : action === 'resume' ? '继续' : '重试';
}

function randomEventId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
