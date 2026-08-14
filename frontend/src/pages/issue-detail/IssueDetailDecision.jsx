import {
  CheckCircle,
  ClipboardCheck,
  MessageCircle,
  UserCheck,
  XCircle,
} from 'lucide-react';

export default function IssueDetailDecision({ evidence, decision, onAccept, onReject, onRequestChanges }) {
  const request = decision?.request;
  const humanOwned = decision?.owner === 'human' && request?.status === 'open';
  const piState = piDecisionCopy(decision);
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderLeft: '4px solid #8b5cf6' }}>
      <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <UserCheck size={18} color="#8b5cf6" /> {humanOwned ? '需要你审批' : piState.title}
      </h3>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        {humanOwned
          ? 'PI 无法自主决定下面的产品、范围或风险取舍，请明确审批；技术验证仍由 PI 负责。'
          : piState.detail}
      </p>
      {humanOwned && (
        <div className="issue-error-text" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: 'var(--radius-md)', padding: '10px', fontSize: '0.82rem', fontWeight: 700 }}>
          你正在审批：{request.question}
        </div>
      )}
      {evidence && (
        <div className="issue-error-text" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: 'var(--radius-md)', padding: '10px', fontSize: '0.78rem' }}>
          {evidence}
        </div>
      )}
      {humanOwned && <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button className="btn btn-secondary btn-success" onClick={onAccept}>
          <CheckCircle size={14} /> 同意，交给 PI 继续判断
        </button>
        <button className="btn btn-secondary btn-danger" onClick={onReject}>
          <XCircle size={14} /> 不同意，交给 PI 处理
        </button>
        <button className="btn btn-secondary" onClick={onRequestChanges}>
          <MessageCircle size={14} /> 输入调整意见并继续同一 Session
        </button>
      </div>}
    </section>
  );
}

function piDecisionCopy(decision) {
  const error = decision?.activity?.error;
  if (decision?.phase === 'pi_deciding') {
    return {
      detail: 'PI 正在读取 Provider Session、最近命令和工作区事实，并自主作出结论。',
      title: 'PI 正在自主验收',
    };
  }
  if (decision?.phase === 'pi_continuing') {
    return {
      detail: 'PI 正在同一个 Session 的新 Run/Turn 中按意见调整并重新验证。',
      title: 'PI 正在按意见调整',
    };
  }
  if (decision?.phase === 'pi_error') {
    return {
      detail: error ? `PI 验收启动失败：${error}` : 'PI 验收启动失败，系统会重试；需要人类决策时会明确通知。',
      title: 'PI 验收遇到问题',
    };
  }
  if (decision?.phase === 'pi_waiting') {
    return {
      detail: 'PI 尚未作出最终判断；Issue 会保持运行中，不会让下一个同项目 Issue 抢跑。',
      title: '等待 PI 判断',
    };
  }
  return {
    detail: 'PI 验收任务已进入队列；开始运行后这里会显示真实进度。',
    title: 'PI 验收已排队',
  };
}

export function HumanReviewResponseModal({ action, draft, request, submitting, onDraftChange, onCancel, onConfirm }) {
  const rejecting = action === 'reject';
  const title = rejecting ? '不同意 PI 建议' : action === 'accept' ? '同意 PI 建议' : '提出调整意见';
  const commentRequired = action !== 'accept';
  return (
    <div className="modal-overlay">
      <form
        className="glass-card modal-content human-review-response-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="issue-delete-modal-header">
          <ClipboardCheck size={18} color="var(--primary)" />
          <h3>{title}</h3>
        </div>
        <p><strong>你正在审批：</strong>{request?.question}</p>
        <p>{action === 'request_changes'
          ? '意见会原样发回同一个 Provider Session，在新的 Run/Turn 中调整并重新验证。'
          : '结论会写入活动记录，并作为后续状态的人工依据。'}</p>
        <textarea
          className="form-control"
          rows={5}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={rejecting ? '说明拒绝原因…' : action === 'request_changes' ? '说明需要修改的内容…' : '补充说明（可选）…'}
          autoFocus={commentRequired}
          disabled={submitting}
        />
        <div className="issue-delete-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>取消</button>
          <button type="submit" className={rejecting ? 'btn btn-danger' : 'btn btn-primary'} disabled={submitting || (commentRequired && !draft.trim())}>
            {submitting ? '提交中…' : action === 'request_changes' ? '提交调整意见并继续本 Session' : `确认${title}`}
          </button>
        </div>
      </form>
    </div>
  );
}
