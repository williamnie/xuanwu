const ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'minmax(140px, 1fr) 96px 64px',
  gap: '12px',
  alignItems: 'center',
  fontSize: '0.82rem',
};

export default function CodexUsageBreakdown({ projects = [] }) {
  if (!projects.length) {
    return (
      <div style={{ border: '1px dashed var(--border-color)', borderRadius: '8px', padding: '14px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        暂无可关联的 project/session/issue metadata，后端会把无法关联的数据归入 unknown。
      </div>
    );
  }
  const max = Math.max(1, ...projects.map(project => project.usage?.total_tokens || 0));
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <BreakdownHeader />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {projects.map(project => <ProjectUsageRow key={project.id} project={project} max={max} />)}
      </div>
    </div>
  );
}

function BreakdownHeader() {
  return (
    <div>
      <h4 style={{ fontSize: '0.95rem', marginBottom: '4px' }}>Project 用量占比</h4>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        按 Codex session metadata 的 cwd 关联项目；无法关联的数据单独显示为 unknown。
      </p>
    </div>
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
      <div style={{ height: '7px', borderRadius: '999px', background: 'var(--border-color)', overflow: 'hidden', marginTop: '8px' }}>
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
    <div style={{ background: 'var(--bg-primary)', borderRadius: '7px', padding: '10px', minWidth: 0 }}>
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
