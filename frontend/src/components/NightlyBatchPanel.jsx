import { Moon } from 'lucide-react';
import { currentNightlyItem, nextNightlyItem } from '../utils/nightlyBatch';

export function NightlySelectRow({ issue, selected, onToggle }) {
  return (
    <label
      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.74rem', color: 'var(--text-secondary)' }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(issue.id)}
      />
      Nightly queue
    </label>
  );
}

export function NightlyBatchPanel({ batch, selectedIssues, policy, onPolicyChange, onCreate, creating, canCreate }) {
  const nextItem = nextNightlyItem(batch);
  const currentItem = currentNightlyItem(batch);
  return (
    <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Moon size={16} color="var(--primary)" />
          <strong>Nightly queue</strong>
          {batch && <span className={`status-badge ${batch.status}`}>{batch.status}</span>}
        </div>
        <NightlyBatchActions
          policy={policy}
          onPolicyChange={onPolicyChange}
          onCreate={onCreate}
          creating={creating}
          canCreate={canCreate}
          count={selectedIssues.length}
        />
      </div>

      <NightlySelectedSummary issues={selectedIssues} canCreate={canCreate} />
      <NightlyBatchStatus batch={batch} currentItem={currentItem} nextItem={nextItem} />
    </div>
  );
}

function NightlyBatchActions({ policy, onPolicyChange, onCreate, creating, canCreate, count }) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <select className="form-control" style={{ width: '150px', padding: '6px 8px', fontSize: '0.78rem' }} value={policy} onChange={(event) => onPolicyChange(event.target.value)}>
        <option value="fail_stop">fail-stop</option>
        <option value="continue">continue</option>
      </select>
      <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '0.78rem' }} disabled={!canCreate || creating} onClick={onCreate}>
        {creating ? 'Creating...' : `Create batch (${count})`}
      </button>
    </div>
  );
}

function NightlySelectedSummary({ issues, canCreate }) {
  if (issues.length === 0) return null;
  return (
    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
      将按 runner claim 顺序创建：{issues.map(issue => `#${issue.id}`).join(' → ')}
      {!canCreate && <span style={{ color: 'var(--error)', marginLeft: '8px' }}>请选择同一项目的 issue</span>}
    </div>
  );
}

function NightlyBatchStatus({ batch, currentItem, nextItem }) {
  if (!batch) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>从 Triage 卡片勾选今晚要跑的 issue，batch 会一次只推进一个 Todo。</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        当前：{currentItem ? `#${currentItem.issue_id}` : '无'} · 下一项：{nextItem ? `#${nextItem.issue_id}` : '无'}
        {batch.pause_reason && <span style={{ color: 'var(--warning)', marginLeft: '8px' }}>Paused: {batch.pause_reason}</span>}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {batch.items?.map(item => (
          <span key={item.issue_id} className={`status-badge ${item.status}`} title={item.issue?.title || ''}>
            #{item.issue_id} {item.status}
          </span>
        ))}
      </div>
    </div>
  );
}
