import { ExternalLink, MessageCircle, Send, StickyNote } from 'lucide-react';

export default function IssueDetailComments({
  count,
  draft,
  error,
  submitting,
  sessionRef,
  navigateTo,
  onDraftChange,
  onSubmit,
}) {
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
