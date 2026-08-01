import { Activity, AlertTriangle, ExternalLink, FileText, Pencil } from 'lucide-react';
import MarkdownPreview from '../../components/editor/MarkdownPreview';
import { canEditIssue } from '../../utils/issueEdit';
import {
  formatRelativeTime,
  issueSourceSessionRef,
  issueStatusDescription,
  summarize,
} from './issueDetailFormatters';

export default function IssueDetailOverview({
  issue,
  project,
  latestRun,
  executionSummary,
  executionSessionRef,
  navigateTo,
  onEdit,
}) {
  const issueBody = String(issue.description || '').trim();
  return (
    <>
      <header className="issue-detail-hero glass-card">
        <div className="issue-detail-kicker">
          <span>{project ? project.name : issue.project_id}</span>
          <span>Issue #{issue.id}</span>
          <span>{formatRelativeTime(issue.updated_at)} 更新</span>
        </div>
        <div className="issue-detail-title-row">
          <div>
            <h1>{issue.title}</h1>
            <p>{issueStatusDescription(issue.status, latestRun)}</p>
          </div>
          <span className={`status-badge ${issue.status} issue-detail-status`}>
            {issue.status === 'in_progress' && !latestRun?.ended_at && <span className="status-dot running" />}
            {issue.status === 'in_progress' && latestRun?.ended_at ? 'PI 判断中' : issue.status}
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
              <button className="kanban-card-action-btn" type="button" onClick={onEdit}>
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
    </>
  );
}

export function IssueStatusAlerts({ issue, executionSummary, onShowRuns, onShowLogs }) {
  const dependency = issue.dependency;
  const dependencyBlocked = issue.status === 'todo' && dependency?.ready === false;
  const dependencyDanger = ['failed_dependency', 'missing_dependency', 'dependency_cycle'].includes(dependency?.reason);
  return (
    <>
      {dependencyBlocked && (
        <div className={`issue-inline-alert ${dependencyDanger ? 'danger' : 'warning'}`} role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>依赖等待 · {dependency.compatibility?.relation_authority || 'work_relations'}</strong>
            <p>{dependency.waiting_reason}</p>
            <p>直接依赖：{dependencyRefs(dependency.direct_dependencies)}；根 blocker：{dependencyRefs(dependency.root_blockers)}</p>
          </div>
        </div>
      )}

      {executionSummary.statusConflict && (
        <div className="issue-inline-alert warning" role="status">
          <AlertTriangle size={17} />
          <div>
            <strong>状态需要核对</strong>
            <p>Issue 为 {issue.status}，最新 Run 为 {executionSummary.runStatus}。页面不再把历史 workflow 推断当作最终结论，请先查看 Session 或 Runs。</p>
          </div>
          <button type="button" onClick={onShowRuns}>查看 Runs</button>
        </div>
      )}

      {executionSummary.awaitingPi && (
        <div className="issue-inline-alert warning" role="status">
          <Activity size={17} />
          <div>
            <strong>PI 正在读取执行上下文</strong>
            <p>Provider Turn 已结束，但 Issue 仍保持 in_progress 和项目锁；PI 决定完成、继续、重试或 needs_user 后才会进入下一项。</p>
          </div>
          <button type="button" onClick={onShowRuns}>查看最新 Run</button>
        </div>
      )}

      {issue.error && (
        <div className="issue-error-card issue-inline-alert danger" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>执行异常</strong>
            <p className="issue-error-text">{issue.error}</p>
          </div>
          <button type="button" onClick={onShowLogs}>查看日志</button>
        </div>
      )}
    </>
  );
}

function dependencyRefs(refs = []) {
  if (refs.length === 0) return '无';
  return refs.map(ref => ref.issue_id ? `#${ref.issue_id} (${ref.status})` : `${ref.work_id} (${ref.status})`).join('、');
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
        <div className={`issue-verification-fact ${summary.piDecision.state}`}>
          <span>PI 状态</span>
          <strong>{summary.piDecision.label}</strong>
          <p>{summary.piDecision.detail}</p>
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
