import { Moon } from 'lucide-react';
import { currentNightlyItem, nextNightlyItem } from '../utils/nightlyBatch';

export default function DashboardNightlyBatch({ batch, navigateTo }) {
  if (!batch) {
    return (
      <div className="glass-card" style={{ padding: '16px 20px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Moon size={16} /> Nightly queue 尚未创建</span>
        <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.78rem' }} onClick={() => navigateTo('issues')}>去选择 Triage</button>
      </div>
    );
  }
  const current = currentNightlyItem(batch);
  const next = nextNightlyItem(batch);
  return (
    <div className="glass-card" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <DashboardNightlyHeader batch={batch} navigateTo={navigateTo} />
      <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
        当前：{current ? `#${current.issue_id}` : '无'} · 下一项：{next ? `#${next.issue_id}` : '无'} · 策略：{batch.policy}
        {batch.pause_reason && <span style={{ color: 'var(--warning)', marginLeft: '8px' }}>Paused: {batch.pause_reason}</span>}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {batch.items?.map(item => (
          <span key={item.issue_id} className={`status-badge ${item.status}`}>#{item.issue_id} {item.status}</span>
        ))}
      </div>
    </div>
  );
}

function DashboardNightlyHeader({ batch, navigateTo }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
        <Moon size={16} color="var(--primary)" /> Nightly queue
        <span className={`status-badge ${batch.status}`}>{batch.status}</span>
      </h3>
      <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.78rem' }} onClick={() => navigateTo('issues')}>查看队列</button>
    </div>
  );
}
