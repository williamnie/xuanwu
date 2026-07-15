import { useState } from 'react';
import { ExternalLink, Info, Loader2, Plus } from 'lucide-react';
import { workApi } from '../../api/work.js';
import { message as toast } from '../../store/toastStore';
import { buildSessionIssuePayload } from './sourceIssue';

export function SessionInfoPopover({ session, provider, sessionId, model, navigateTo }) {
  const linkedIssue = session?.linked_issue || null;
  const sourceIssues = session?.source_issues || [];
  const tokens = tokenSummary(session?.token_usage);
  return (
    <details className="session-info-popover">
      <summary className="session-info-trigger" title="查看会话信息" aria-label="查看会话信息">
        <Info size={14} />
      </summary>
      <div className="session-info-panel">
        <div className="session-info-section">
          <span className="session-info-section-title">Session</span>
          <InfoRow label="ID" value={<code>{displayValue(sessionId)}</code>} />
          <InfoRow label="Provider" value={displayValue(provider)} />
          <InfoRow label="Model" value={displayValue(model, '未提供')} />
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">关联 Issue</span>
          {linkedIssue ? (
            <>
              <InfoRow label="Issue" value={`#${linkedIssue.id} ${linkedIssue.title || '未命名'}`} />
              <InfoRow label="Status" value={displayValue(linkedIssue.status)} />
            </>
          ) : (
            <div className="session-info-empty">未关联</div>
          )}
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">由此讨论创建</span>
          {sourceIssues.length > 0 ? (
            sourceIssues.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className="session-source-issue-link"
                onClick={() => navigateTo?.('issues', issue.id)}
              >
                <span>#{issue.id} {issue.title || '未命名'}</span>
                <ExternalLink size={12} />
              </button>
            ))
          ) : (
            <div className="session-info-empty">暂无来源型 Issue</div>
          )}
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">Token 使用</span>
          {tokens ? (
            <>
              <InfoRow label="Total" value={tokens.total} />
              <InfoRow label="Last turn" value={tokens.last} />
              <InfoRow label="Input / Output" value={`${tokens.input} / ${tokens.output}`} />
              <InfoRow label="Reasoning" value={tokens.reasoning} />
              {tokens.capturedAt && <InfoRow label="Updated" value={tokens.capturedAt} />}
            </>
          ) : (
            <div className="session-info-empty">暂无 token 数据</div>
          )}
        </div>
      </div>
    </details>
  );
}

export function CreateSessionIssueButton({ session, project, navigateTo }) {
  const [creating, setCreating] = useState(false);

  const createIssue = async () => {
    if (creating) return;
    if (!project?.id) {
      toast.error('未找到当前 Session 对应的 Runner 项目，无法创建 Issue。');
      return;
    }
    setCreating(true);
    try {
      const selectedText = window.getSelection?.().toString() || '';
      const issue = await workApi.createIssue(buildSessionIssuePayload(session, project, { selectedText }));
      toast.success(`已创建 triage Issue #${issue.id}`);
      navigateTo?.('issues', issue.id);
    } catch (err) {
      toast.error(err.message || '从 Session 创建 Issue 失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <button
      type="button"
      className="session-source-issue-button"
      onClick={createIssue}
      disabled={creating}
      title="从 Session 创建 Issue"
    >
      {creating ? <Loader2 className="animate-spin" size={13} /> : <Plus size={13} />}
      从 Session 创建 Issue
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="session-info-row">
      <span className="session-info-label">{label}</span>
      <span className="session-info-value">{value}</span>
    </div>
  );
}

function displayValue(value, fallback = '未提供') {
  const text = String(value || '').trim();
  return text || fallback;
}

function formatTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : '0';
}

function tokenSummary(usage) {
  const total = usage?.total_token_usage || {};
  const last = usage?.last_token_usage || {};
  if (!usage || (!total.total_tokens && !last.total_tokens)) return null;
  return {
    total: formatTokenNumber(total.total_tokens),
    last: formatTokenNumber(last.total_tokens),
    input: formatTokenNumber(total.input_tokens),
    output: formatTokenNumber(total.output_tokens),
    reasoning: formatTokenNumber(total.reasoning_output_tokens),
    capturedAt: usage.captured_at || '',
  };
}
