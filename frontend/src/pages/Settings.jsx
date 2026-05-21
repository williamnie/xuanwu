import IssueTemplatesPanel from './IssueTemplatesPanel';

export default function Settings() {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      <div style={{ flexShrink: 0, padding: '24px 0 8px 0' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>系统设置</h1>
        <p style={{ color: 'var(--text-muted)' }}>管理全局执行配置与 Codex Issue Runner 行为。</p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' }}>
        <IssueTemplatesPanel />
      </div>
    </div>
  );
}
