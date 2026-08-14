import { useState } from 'react';

const ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'minmax(140px, 1fr) 96px 64px',
  gap: '12px',
  alignItems: 'center',
  fontSize: '0.82rem',
};

export default function CodexUsageBreakdown({ projects = [] }) {
  const [expanded, setExpanded] = useState(false);

  if (!projects.length) {
    return (
      <div style={{ border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', padding: '14px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        暂无可关联的 project/session/issue metadata，后端会把无法关联的数据归入 unknown。
      </div>
    );
  }
  const max = Math.max(1, ...projects.map(project => project.usage?.total_tokens || 0));
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: expanded ? '12px' : 0 }}>
      <BreakdownHeader expanded={expanded} projectCount={projects.length} onToggle={() => setExpanded(value => !value)} />
      {expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
      style={{
        width: '100%',
        border: 0,
        padding: 0,
        background: 'transparent',
        color: 'inherit',
        display: 'flex',
        justifyContent: 'space-between',
        gap: '16px',
        alignItems: 'center',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span>
        <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>Project 用量占比</span>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
          {projectCount} 个 project，按 Codex session metadata 的 cwd 关联；点击{expanded ? '收起' : '展开'}明细。
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.8rem', flexShrink: 0 }}>
        {expanded ? '收起' : '展开'}
        <span style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>⌄</span>
      </span>
    </button>
  );
}

function ProjectUsageRow({ project, max }) {
  const total = project.usage?.total_tokens || 0;
  const sessions = project.sessions || [];
  const issues = project.issues || [];
  return (
    <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
      <div style={ROW_STYLE}>
        <ProjectLabel project={project} />
        <strong style={{ textAlign: 'right' }}>{formatTokens(total)}</strong>
        <span style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{formatPercent(project.percent)}</span>
      </div>
      <div style={{ height: '7px', borderRadius: 'var(--radius-xs)', background: 'var(--border-color)', overflow: 'hidden', marginTop: '8px' }}>
        <div style={{ width: `${Math.max(2, (total / max) * 100)}%`, height: '100%', background: project.unknown ? 'var(--warning)' : 'var(--primary-gradient)' }} />
      </div>
      <UsageDrilldown sessions={sessions} issues={issues} />
    </div>
  );
}

function ProjectLabel({ project }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name || project.id}</span>
        {project.unknown ? <span className="status-badge failed">unknown</span> : null}
      </div>
      {project.cwd ? <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.cwd}</div> : null}
    </div>
  );
}

function UsageDrilldown({ sessions, issues }) {
  if (!sessions.length && !issues.length) return null;
  return (
    <div style={{ marginTop: '10px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
      <DrilldownList title="Sessions" items={sessions.slice(0, 3)} renderItem={renderSessionItem} />
      <DrilldownList title="Issues" items={issues.slice(0, 3)} renderItem={renderIssueItem} />
    </div>
  );
}

function DrilldownList({ title, items, renderItem }) {
  return (
    <div style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', padding: '10px', minWidth: 0 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, marginBottom: '6px' }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>无可关联 metadata</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>{items.map(renderItem)}</div>
      )}
    </div>
  );
}

function renderSessionItem(session) {
  return (
    <div key={session.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.72rem' }}>
      <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.unknown ? 'unknown' : session.id}</code>
      <strong>{formatTokens(session.usage?.total_tokens || 0)}</strong>
    </div>
  );
}

function renderIssueItem(issue) {
  return (
    <div key={issue.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.72rem' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{issue.id} {issue.title || 'Issue'}</span>
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
