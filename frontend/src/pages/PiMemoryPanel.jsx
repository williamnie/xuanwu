import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Pin, Plus, Save, Trash2, XCircle } from 'lucide-react';
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
            管理 PI 记忆；明确授权的低风险个人偏好可自动启用，候选 promote 后才进入 heartbeat / prompt 检索上下文。
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
      <MemoryDigestPanel state={state} />
      <MemoryCreateForm state={state} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      <MemoryList state={state} />
    </section>
  );
}

function usePiMemoryPanel() {
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [digest, setDigest] = useState(null);
  const [digestWindow, setDigestWindow] = useState('daily');
  const [newDraft, setNewDraft] = useState(defaultNewDraft);
  const [selectedIds, setSelectedIds] = useState([]);
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
  const loadDigest = useCallback(async () => {
    try {
      setDigest(await loadMemoryDigest({ digestWindow }));
    } catch (err) {
      setError(err.message || '生成 PI memory digest 失败');
    }
  }, [digestWindow]);
  useEffect(() => { loadDigest(); }, [loadDigest]);
  const create = useCallback(async () => {
    setBusy('new:create');
    try {
      await createMemory({ newDraft });
      message.success('PI memory 已添加');
      setNewDraft(defaultNewDraft());
      await load();
    } catch (err) {
      message.error(err.message || '添加 PI memory 失败');
    } finally {
      setBusy('');
    }
  }, [load, newDraft]);
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
  const bulkAction = useCallback(async (name) => {
    if (selectedIds.length === 0) return;
    setBusy(`bulk:${name}`);
    try {
      await piMemoryApi.batch({ action: name, ids: selectedIds });
      message.success('PI memory batch review 已更新');
      setSelectedIds([]);
      await load();
      await loadDigest();
    } catch (err) {
      message.error(err.message || '批量更新 PI memory 失败');
    } finally {
      setBusy('');
    }
  }, [load, loadDigest, selectedIds]);
  const toggleSelected = useCallback((id, checked) => {
    setSelectedIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  }, []);
  const updateDraft = useCallback((id, field, value) => setDrafts((current) => ({
    ...current, [id]: { ...(current[id] || {}), [field]: value }
  })), []);
  const updateNewDraft = useCallback((field, value) => setNewDraft((current) => ({ ...current, [field]: value })), []);
  return {
    action, bulkAction, busy, create, digest, digestWindow, drafts, error, items, load, loadDigest,
    loading, newDraft, selectedIds, setDigestWindow, toggleSelected, updateDraft, updateNewDraft
  };
}

function MemoryDigestPanel({ state }) {
  const totals = state.digest?.totals;
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '0.94rem', marginBottom: '4px' }}>Daily/Weekly digest</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>
            digest draft 按 scope / layer / type 分组；策略或权限类候选只进入 review，不自动进入 active long_term。
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <SmallSelect label="window" value={state.digestWindow} values={['daily', 'weekly']} onChange={state.setDigestWindow} />
          <button className="btn btn-secondary" onClick={state.loadDigest} disabled={Boolean(state.busy)}>生成 digest</button>
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5 }}>
        batch review：已选 {state.selectedIds.length} 条；digest 候选 {totals?.candidate_count ?? 0} 条，
        建议 promote {totals?.recommend_promote ?? 0} / forget {totals?.recommend_forget ?? 0}，
        需用户确认 {totals?.requires_confirmation ?? 0}。
      </p>
      <BulkButtons state={state} />
    </div>
  );
}

function BulkButtons({ state }) {
  const disabled = Boolean(state.busy) || state.selectedIds.length === 0;
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" onClick={() => state.bulkAction('promote')} disabled={disabled}><Check size={14} />批量启用</button>
      <button className="btn btn-secondary" onClick={() => state.bulkAction('pin')} disabled={disabled}><Pin size={14} />批量 Pin</button>
      <button className="btn btn-secondary" onClick={() => state.bulkAction('disable')} disabled={disabled}><XCircle size={14} />批量禁用</button>
      <button className="btn btn-secondary" onClick={() => state.bulkAction('forget')} disabled={disabled}><Trash2 size={14} />批量忘记</button>
    </div>
  );
}

function MemoryCreateForm({ state }) {
  const draft = state.newDraft;
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px', background: 'var(--bg-secondary)' }}>
      <h3 style={{ fontSize: '0.94rem', marginBottom: '8px' }}>手动添加</h3>
      <textarea
        className="form-control"
        placeholder="写入一条可审计、可删除的 PI memory"
        rows={3}
        value={draft.content}
        onChange={(event) => state.updateNewDraft('content', event.target.value)}
      />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
        <SmallSelect label="memory_type" value={draft.memory_type} values={MEMORY_TYPES} onChange={(value) => state.updateNewDraft('memory_type', value)} />
        <SmallSelect label="layer" value={draft.layer} values={MEMORY_LAYERS} onChange={(value) => state.updateNewDraft('layer', value)} />
        <SmallInput label="scope" value={draft.scope} onChange={(value) => state.updateNewDraft('scope', value)} />
        <SmallInput label="scope_id" value={draft.scope_id} onChange={(value) => state.updateNewDraft('scope_id', value)} />
        <SmallInput label="kind" value={draft.kind} onChange={(value) => state.updateNewDraft('kind', value)} />
        <SmallInput label="source_type" value={draft.source_type} onChange={(value) => state.updateNewDraft('source_type', value)} />
        <SmallInput label="source_id" value={draft.source_id} onChange={(value) => state.updateNewDraft('source_id', value)} />
        <SmallInput label="citation_label" value={draft.citation_label} onChange={(value) => state.updateNewDraft('citation_label', value)} />
        <SmallInput label="citation_type" value={draft.citation_type} onChange={(value) => state.updateNewDraft('citation_type', value)} />
        <SmallInput label="citation_id" value={draft.citation_id} onChange={(value) => state.updateNewDraft('citation_id', value)} />
        <SmallInput label="citation_url" value={draft.citation_url} onChange={(value) => state.updateNewDraft('citation_url', value)} />
        <SmallInput label="confidence" value={draft.confidence} onChange={(value) => state.updateNewDraft('confidence', value)} />
        <button className="btn btn-primary" onClick={state.create} disabled={Boolean(state.busy) || !draft.content.trim()}>
          <Plus size={14} />添加
        </button>
      </div>
    </div>
  );
}

function MemoryList({ state }) {
  if (!state.loading && state.items.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem', lineHeight: 1.55 }}>
        暂无 PI memory 或候选记忆。PI Assistant chat / manager cycle / supervisor 会通过
        <code> memory_write_candidate </code>写入记忆；明确授权的低风险个人偏好可自动启用，
        failure-pattern generator 会在 heartbeat 发现重复失败时写候选。推断、敏感、低置信度、项目/团队策略仍会保留为候选。
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
        写入来源：PI Assistant chat / manager cycle / supervisor 通过 <code>memory_write_candidate</code> 记录。
        仅用户明确授权的低风险个人偏好可自动启用；推断、敏感、低置信度、项目/团队策略仍会保留为候选。
        可随时禁用或删除已启用记忆。
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
        <strong>{item.memory_type || 'user'} / {item.kind}</strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
          <input
            checked={state.selectedIds.includes(item.id)}
            onChange={(event) => state.toggleSelected(item.id, event.target.checked)}
            type="checkbox"
          />
          batch review
        </label>
        <span style={{ color: candidate ? 'var(--warning)' : 'var(--success)', fontSize: '0.78rem', fontWeight: 700 }}>
          {candidate ? 'candidate / disabled' : 'active'} · {Number(item.pinned) === 1 ? 'pinned' : 'unpinned'} · {item.layer || 'working'} · {item.scope}:{item.scope_id || 'runner'} · {item.confidence}
        </span>
      </div>
      <textarea className="form-control" value={draft.content} onChange={(event) => state.updateDraft(item.id, 'content', event.target.value)} rows={3} />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
        <SmallSelect label="memory_type" value={draft.memory_type} values={MEMORY_TYPES} onChange={(value) => state.updateDraft(item.id, 'memory_type', value)} />
        <SmallSelect label="layer" value={draft.layer} values={MEMORY_LAYERS} onChange={(value) => state.updateDraft(item.id, 'layer', value)} />
        <SmallInput label="kind" value={draft.kind} onChange={(value) => state.updateDraft(item.id, 'kind', value)} />
        <SmallInput label="confidence" value={draft.confidence} onChange={(value) => state.updateDraft(item.id, 'confidence', value)} />
        <SmallInput label="source_type" value={draft.source_type} onChange={(value) => state.updateDraft(item.id, 'source_type', value)} />
        <SmallInput label="source_id" value={draft.source_id} onChange={(value) => state.updateDraft(item.id, 'source_id', value)} />
        <SmallInput label="citation_label" value={draft.citation_label} onChange={(value) => state.updateDraft(item.id, 'citation_label', value)} />
        <SmallInput label="citation_type" value={draft.citation_type} onChange={(value) => state.updateDraft(item.id, 'citation_type', value)} />
        <SmallInput label="citation_id" value={draft.citation_id} onChange={(value) => state.updateDraft(item.id, 'citation_id', value)} />
        <SmallInput label="citation_url" value={draft.citation_url} onChange={(value) => state.updateDraft(item.id, 'citation_url', value)} />
        <button className="btn btn-secondary" onClick={() => state.action(item, 'save')} disabled={Boolean(state.busy)}><Save size={14} />保存</button>
        {Number(item.pinned) !== 1 && <button className="btn btn-secondary" onClick={() => state.action(item, 'pin')} disabled={Boolean(state.busy)}><Pin size={14} />Pin</button>}
        {candidate && <button className="btn btn-secondary" onClick={() => state.action(item, 'promote')} disabled={Boolean(state.busy)}><Check size={14} />启用</button>}
        {!candidate && <button className="btn btn-secondary" onClick={() => state.action(item, 'disable')} disabled={Boolean(state.busy)}><XCircle size={14} />禁用</button>}
        <button className="btn btn-secondary" onClick={() => state.action(item, 'forget')} disabled={Boolean(state.busy)}><Trash2 size={14} />忘记</button>
      </div>
      <small style={{ color: 'var(--text-muted)' }}>
        source={item.source_type || '-'}:{item.source_id || '-'} · 引用对象={citationText(item)} · updated={item.updated_at}
      </small>
    </article>
  );
}

function SmallInput({ label, onChange, value }) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>{label}<input className="form-control" style={{ width: '150px' }} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SmallSelect({ label, onChange, value, values }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
      {label}
      <select className="form-control" style={{ width: '150px' }} value={value} onChange={(event) => onChange(event.target.value)}>
        {values.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

function draftFromItem(item) {
  return {
    citation_id: item.citation_id || '',
    citation_label: item.citation_label || '',
    citation_type: item.citation_type || '',
    citation_url: item.citation_url || '',
    confidence: item.confidence || 'medium',
    content: item.content || '',
    kind: item.kind || '',
    layer: item.layer || 'working',
    memory_type: item.memory_type || 'user',
    source_id: item.source_id || '',
    source_type: item.source_type || ''
  };
}

function defaultNewDraft() {
  return {
    citation_id: '',
    citation_label: '',
    citation_type: 'manual',
    citation_url: '',
    confidence: 'medium',
    content: '',
    kind: 'user_preference',
    layer: 'working',
    memory_type: 'user',
    scope: 'global',
    scope_id: 'runner',
    source_id: 'settings-memory-form',
    source_type: 'manual'
  };
}

function createMemory(state) {
  return piMemoryApi.create(state.newDraft);
}

function loadMemoryDigest(state) {
  return piMemoryApi.digest({ window: state.digestWindow });
}

function runMemoryAction(item, name, draft) {
  if (name === 'pin') return piMemoryApi.pin(item.id);
  if (name === 'promote') return piMemoryApi.promote(item.id);
  if (name === 'disable') return piMemoryApi.disable(item.id);
  if (name === 'forget') return piMemoryApi.forget(item.id);
  if (name === 'delete') return piMemoryApi.remove(item.id);
  return piMemoryApi.update(item.id, {
    citation_id: draft.citation_id,
    citation_label: draft.citation_label,
    citation_type: draft.citation_type,
    citation_url: draft.citation_url,
    confidence: draft.confidence,
    content: draft.content,
    kind: draft.kind,
    layer: draft.layer,
    memory_type: draft.memory_type,
    source_id: draft.source_id,
    source_type: draft.source_type
  });
}

function citationText(item) {
  const ref = [item.citation_type, item.citation_id].filter(Boolean).join(':');
  return [ref, item.citation_label || item.citation_url].filter(Boolean).join(' ') || '-';
}

const MEMORY_TYPES = ['user', 'project', 'inbox', 'source', 'skill'];
const MEMORY_LAYERS = ['ephemeral', 'working', 'long_term'];
