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

export default function IssueDetailVerification({ evidence, onAccept, onReject, onRequestChanges }) {
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

export function VerificationReviewModal({ action, draft, submitting, onDraftChange, onCancel, onConfirm }) {
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
