import {
  CheckCircle,
  ClipboardCheck,
  MessageCircle,
  RotateCw,
  UserCheck,
  XCircle,
} from 'lucide-react';
import MarkdownPreview from '../../components/editor/MarkdownPreview';
import { formatDateTime } from './issueDetailFormatters';

export default function IssueDetailVerification({ evidence, verification, onAccept, onReject, onRequestChanges }) {
  const request = verification?.request;
  const humanOwned = verification?.owner === 'human' && request?.status === 'open';
  const piState = piVerificationCopy(verification);
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
        <div className="issue-error-text" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: '8px', padding: '10px', fontSize: '0.82rem', fontWeight: 700 }}>
          你正在审批：{request.question}
        </div>
      )}
      {evidence && (
        <div className="issue-error-text" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: '8px', padding: '10px', fontSize: '0.78rem' }}>
          {evidence}
        </div>
      )}
      {humanOwned && <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button className="btn btn-secondary btn-success" onClick={onAccept}>
          <CheckCircle size={14} /> Accept → Done
        </button>
        <button className="btn btn-secondary btn-danger" onClick={onReject}>
          <XCircle size={14} /> Reject → Failed
        </button>
        <button className="btn btn-secondary" onClick={onRequestChanges}>
          <MessageCircle size={14} /> 输入调整意见并继续同一 Session
        </button>
      </div>}
    </section>
  );
}

function piVerificationCopy(verification) {
  const error = verification?.activity?.error;
  if (verification?.phase === 'pi_verifying') {
    return {
      detail: 'PI 验收任务正在运行，会检查证据、修复可确定的问题并自主作出技术结论。',
      title: 'PI 正在自主验收',
    };
  }
  if (verification?.phase === 'pi_repairing') {
    return {
      detail: 'PI 正在同一个 Session 的新 Run/Turn 中按意见调整并重新验证。',
      title: 'PI 正在按意见调整',
    };
  }
  if (verification?.phase === 'pi_blocked') {
    return {
      detail: error ? `PI 验收启动失败：${error}` : 'PI 验收启动失败，系统会重试；需要人类决策时会明确通知。',
      title: 'PI 验收遇到问题',
    };
  }
  if (verification?.phase === 'pi_waiting') {
    return {
      detail: '上一轮 PI 检查尚未完成门禁，系统会继续补齐证据或启动 Verifier；当前不需要你操作。',
      title: 'PI 正在补齐验收证据',
    };
  }
  return {
    detail: 'PI 验收任务已进入队列；开始运行后这里会显示真实进度。',
    title: 'PI 验收已排队',
  };
}

export function VerificationReviewModal({ action, draft, request, submitting, onDraftChange, onCancel, onConfirm }) {
  const rejecting = action === 'reject';
  const title = rejecting ? '拒绝验证' : action === 'accept' ? '接受验收' : '请求修改';
  const commentRequired = action !== 'accept';
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

export function VerifierReportPanel({ reports, generating, error, onGenerate }) {
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
