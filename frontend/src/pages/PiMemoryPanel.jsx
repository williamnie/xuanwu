import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Save, Trash2, XCircle } from 'lucide-react';
import { piMemoryApi } from '../api/piMemoryClient';
import { message } from '../store/toastStore';

export default function PiMemoryPanel() {
  const state = usePiMemoryPanel();
  const activeCount = state.items.filter((item) => Number(item.disabled) === 0).length;
  const candidateCount = state.items.filter((item) => Number(item.disabled) === 1).length;
  const recentCandidateSource = state.items.find((item) => Number(item.disabled) === 1);
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>PI Memory Review</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            审核 PI 写入的候选记忆；promote 后才进入 heartbeat / prompt 检索上下文。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={state.load} disabled={state.loading}>
          {state.loading ? <Loader2 size={15} className="spin-animation" /> : null} 刷新
        </button>
      </div>
      <MemorySummary
        activeCount={activeCount}
        candidateCount={candidateCount}
        recentCandidateSource={recentCandidateSource}
      />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      <MemoryList state={state} />
    </section>
  );
}

function usePiMemoryPanel() {
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const memory = await piMemoryApi.list();
      setItems(Array.isArray(memory) ? memory : []);
      setDrafts(Object.fromEntries((Array.isArray(memory) ? memory : []).map((item) => [item.id, draftFromItem(item)])));
      setError('');
    } catch (err) {
      setError(err.message || '读取 PI memory 失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const action = useCallback(async (item, name) => {
    setBusy(`${item.id}:${name}`);
    try {
      await runMemoryAction(item, name, drafts[item.id] || {});
      message.success('PI memory 已更新');
      await load();
    } catch (err) {
      message.error(err.message || '更新 PI memory 失败');
    } finally {
      setBusy('');
    }
  }, [drafts, load]);
  const updateDraft = useCallback((id, field, value) => setDrafts((current) => ({
    ...current, [id]: { ...(current[id] || {}), [field]: value }
  })), []);
  return { action, busy, drafts, error, items, load, loading, updateDraft };
}

function MemoryList({ state }) {
  if (!state.loading && state.items.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem', lineHeight: 1.55 }}>
        暂无 PI memory 或候选记忆。Runner Chat / manager cycle / supervisor 会通过
        <code> memory_write_candidate </code>写入 disabled candidate；failure-pattern generator 会在 heartbeat
        发现重复失败时写候选。候选必须人工启用后才会注入 prompt。
      </div>
    );
  }
  return <div style={{ display: 'grid', gap: '10px' }}>{state.items.map((item) => <MemoryCard key={item.id} item={item} state={state} />)}</div>;
}

function MemorySummary({ activeCount, candidateCount, recentCandidateSource }) {
  const source = recentCandidateSource
    ? `${recentCandidateSource.source_type || 'unknown'}:${recentCandidateSource.source_id || recentCandidateSource.id}`
    : '暂无';
  return (
    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
      <SummaryPill label="Active memory" value={`${activeCount} 条`} />
      <SummaryPill label="Candidate memory" value={`${candidateCount} 条待审核`} />
      <SummaryPill label="最近候选来源" value={source} />
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', gridColumn: '1 / -1', lineHeight: 1.55, margin: 0 }}>
        写入来源：Runner Chat / manager cycle / supervisor 仅可调用 <code>memory_write_candidate</code> 写 disabled candidate；
        failure-pattern generator 也只写候选，必须人工启用后才会注入 prompt。
      </p>
    </div>
  );
}

function SummaryPill({ label, value }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: '12px', padding: '10px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700 }}>{label}</div>
      <strong style={{ color: 'var(--text-primary)', fontSize: '0.98rem' }}>{value}</strong>
    </div>
  );
}

function MemoryCard({ item, state }) {
  const draft = state.drafts[item.id] || draftFromItem(item);
  const candidate = Number(item.disabled) === 1;
  return (
    <article style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <strong>{item.kind}</strong>
        <span style={{ color: candidate ? 'var(--warning)' : 'var(--success)', fontSize: '0.78rem', fontWeight: 700 }}>
          {candidate ? 'candidate / disabled' : 'active'} · {item.scope}:{item.scope_id || 'runner'} · {item.confidence}
        </span>
      </div>
      <textarea className="form-control" value={draft.content} onChange={(event) => state.updateDraft(item.id, 'content', event.target.value)} rows={3} />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
        <SmallInput label="kind" value={draft.kind} onChange={(value) => state.updateDraft(item.id, 'kind', value)} />
        <SmallInput label="confidence" value={draft.confidence} onChange={(value) => state.updateDraft(item.id, 'confidence', value)} />
        <button className="btn btn-secondary" onClick={() => state.action(item, 'save')} disabled={Boolean(state.busy)}><Save size={14} />保存</button>
        {candidate && <button className="btn btn-secondary" onClick={() => state.action(item, 'promote')} disabled={Boolean(state.busy)}><Check size={14} />启用</button>}
        {!candidate && <button className="btn btn-secondary" onClick={() => state.action(item, 'disable')} disabled={Boolean(state.busy)}><XCircle size={14} />禁用</button>}
        <button className="btn btn-secondary" onClick={() => state.action(item, 'delete')} disabled={Boolean(state.busy)}><Trash2 size={14} />删除</button>
      </div>
      <small style={{ color: 'var(--text-muted)' }}>source={item.source_type || '-'}:{item.source_id || '-'} · updated={item.updated_at}</small>
    </article>
  );
}

function SmallInput({ label, onChange, value }) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>{label}<input className="form-control" style={{ width: '150px' }} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function draftFromItem(item) {
  return { confidence: item.confidence || 'medium', content: item.content || '', kind: item.kind || '' };
}

function runMemoryAction(item, name, draft) {
  if (name === 'promote') return piMemoryApi.promote(item.id);
  if (name === 'disable') return piMemoryApi.disable(item.id);
  if (name === 'delete') return piMemoryApi.remove(item.id);
  return piMemoryApi.update(item.id, { confidence: draft.confidence, content: draft.content, kind: draft.kind });
}
