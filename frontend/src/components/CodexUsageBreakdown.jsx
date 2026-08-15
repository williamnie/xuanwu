import { useState } from 'react';
import './CodexUsagePanel.details.css';

export default function CodexUsageBreakdown({ projects = [] }) {
  const [expanded, setExpanded] = useState(false);

  if (!projects.length) {
    return (
      <div className="codex-usage-breakdown__empty">
        暂无可关联的 project/session/issue metadata，后端会把无法关联的数据归入 unknown。
      </div>
    );
  }
  const max = Math.max(1, ...projects.map(project => project.usage?.total_tokens || 0));
  return (
    <div className={`codex-usage-breakdown${expanded ? ' is-expanded' : ''}`}>
      <BreakdownHeader expanded={expanded} projectCount={projects.length} onToggle={() => setExpanded(value => !value)} />
      {expanded ? (
        <div className="codex-usage-breakdown__projects">
          {projects.map(project => <ProjectUsageRow key={project.id} project={project} max={max} />)}
        </div>
      ) : null}
    </div>
  );
}

function BreakdownHeader({ expanded, projectCount, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="codex-usage-breakdown__toggle"
    >
      <span>
        <span className="codex-usage-breakdown__title">Project 用量占比</span>
        <span className="codex-usage-breakdown__subtitle">
          {projectCount} 个 project，按 Codex session metadata 的 cwd 关联；点击{expanded ? '收起' : '展开'}明细。
        </span>
      </span>
      <span className="codex-usage-breakdown__toggle-label">
        {expanded ? '收起' : '展开'}
        <span className={`codex-usage-breakdown__chevron${expanded ? ' is-expanded' : ''}`}>⌄</span>
      </span>
    </button>
  );
}

function ProjectUsageRow({ project, max }) {
  const total = project.usage?.total_tokens || 0;
  const sessions = project.sessions || [];
  const issues = project.issues || [];
  return (
    <div className="codex-usage-breakdown__project">
      <div className="codex-usage-breakdown__row">
        <ProjectLabel project={project} />
        <strong className="codex-usage-breakdown__number">{formatTokens(total)}</strong>
        <span className="codex-usage-breakdown__percent">{formatPercent(project.percent)}</span>
      </div>
      <div className="codex-usage-breakdown__bar">
        <div className={`codex-usage-breakdown__bar-value${project.unknown ? ' is-unknown' : ''}`} style={{ width: `${Math.max(2, (total / max) * 100)}%` }} />
      </div>
      <UsageDrilldown sessions={sessions} issues={issues} />
    </div>
  );
}

function ProjectLabel({ project }) {
  return (
    <div className="codex-usage-breakdown__project-label">
      <div className="codex-usage-breakdown__project-name">
        <span className="codex-usage-breakdown__truncate">{project.name || project.id}</span>
        {project.unknown ? <span className="status-badge failed">unknown</span> : null}
      </div>
      {project.cwd ? <div className="codex-usage-breakdown__cwd">{project.cwd}</div> : null}
    </div>
  );
}

function UsageDrilldown({ sessions, issues }) {
  if (!sessions.length && !issues.length) return null;
  return (
    <div className="codex-usage-breakdown__drilldown">
      <DrilldownList title="Sessions" items={sessions.slice(0, 3)} renderItem={renderSessionItem} />
      <DrilldownList title="Issues" items={issues.slice(0, 3)} renderItem={renderIssueItem} />
    </div>
  );
}

function DrilldownList({ title, items, renderItem }) {
  return (
    <div className="codex-usage-breakdown__drilldown-list">
      <div className="codex-usage-breakdown__drilldown-title">{title}</div>
      {items.length === 0 ? (
        <div className="codex-usage-breakdown__drilldown-empty">无可关联 metadata</div>
      ) : (
        <div className="codex-usage-breakdown__drilldown-items">{items.map(renderItem)}</div>
      )}
    </div>
  );
}

function renderSessionItem(session) {
  return (
    <div className="codex-usage-breakdown__drilldown-item" key={session.id}>
      <code className="codex-usage-breakdown__truncate">{session.unknown ? 'unknown' : session.id}</code>
      <strong>{formatTokens(session.usage?.total_tokens || 0)}</strong>
    </div>
  );
}

function renderIssueItem(issue) {
  return (
    <div className="codex-usage-breakdown__drilldown-item" key={issue.id}>
      <span className="codex-usage-breakdown__truncate">#{issue.id} {issue.title || 'Issue'}</span>
      <strong>{formatTokens(issue.usage?.total_tokens || 0)}</strong>
    </div>
  );
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}
