import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Pin, Plus, Save, Trash2, XCircle } from 'lucide-react';
import { piMemoryApi } from '../api/piMemoryClient';
import { message } from '../store/toastStore';
import './PiMemoryPanel.css';

export default function PiMemoryPanel() {
  const state = usePiMemoryPanel();
  const activeCount = state.items.filter((item) => Number(item.disabled) === 0).length;
  const disabledCount = state.items.length - activeCount;
  const recent = state.items[0];
  return (
    <section className="glass-card pi-memory-panel">
      <div className="pi-memory-panel__header">
        <div>
          <h2 className="pi-memory-panel__heading">Supervisor Memory</h2>
          <p className="pi-memory-panel__description">
            PI 自动记住可复用的偏好、决策、工作方法、Bug 根因、修复方式和验证经验；相同 memory_key 会更新而不是重复追加。
            当前 Work / Run / Issue 状态永远以实时查询为准，不保存为记忆。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={state.load} disabled={state.loading}>
          {state.loading ? <Loader2 size={15} className="spin-animation" /> : null} 刷新
        </button>
      </div>
      <MemorySummary activeCount={activeCount} disabledCount={disabledCount} recent={recent} />
      <MemoryCreateForm state={state} />
      {state.error && <div className="pi-memory-panel__error">{state.error}</div>}
      <MemoryList state={state} />
    </section>
  );
}

function usePiMemoryPanel() {
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newDraft, setNewDraft] = useState(defaultNewDraft);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const memory = await piMemoryApi.list();
      const list = Array.isArray(memory) ? memory : [];
      setItems(list);
      setDrafts(Object.fromEntries(list.map((item) => [item.id, draftFromItem(item)])));
      setError('');
    } catch (err) {
      setError(err.message || '读取 Supervisor memory 失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const create = useCallback(async () => {
    setBusy('new:create');
    try {
      await piMemoryApi.create({ ...newDraft, disabled: 0 });
      message.success('Supervisor memory 已添加');
      setNewDraft(defaultNewDraft());
      await load();
    } catch (err) {
      message.error(err.message || '添加 Supervisor memory 失败');
    } finally {
      setBusy('');
    }
  }, [load, newDraft]);
  const action = useCallback(async (item, name) => {
    setBusy(`${item.id}:${name}`);
    try {
      await runMemoryAction(item, name, drafts[item.id] || {});
      message.success('Supervisor memory 已更新');
      await load();
    } catch (err) {
      message.error(err.message || '更新 Supervisor memory 失败');
    } finally {
      setBusy('');
    }
  }, [drafts, load]);
  const updateDraft = useCallback((id, field, value) => setDrafts((current) => ({
    ...current, [id]: { ...(current[id] || {}), [field]: value }
  })), []);
  const updateNewDraft = useCallback((field, value) => setNewDraft((current) => ({ ...current, [field]: value })), []);
  return { action, busy, create, drafts, error, items, load, loading, newDraft, updateDraft, updateNewDraft };
}

function MemorySummary({ activeCount, disabledCount, recent }) {
  return (
    <div className="pi-memory-panel__summary">
      <SummaryPill label="Active memory" value={`${activeCount} 条`} />
      <SummaryPill label="Disabled memory" value={`${disabledCount} 条`} />
      <SummaryPill label="最近更新" value={recent ? `${recent.kind} · ${recent.last_seen_at || recent.updated_at}` : '暂无'} />
      <p className="pi-memory-panel__summary-copy">
        记忆自动生效，不需要逐条人工审核。只有稳定、可复用并可追溯的经验才允许写入；低置信度推断、状态快照、数量统计、队列状态和临时承诺会被拒绝。
        你仍可随时编辑、禁用或忘记任何记忆。
      </p>
    </div>
  );
}

function SummaryPill({ label, value }) {
  return (
    <div className="pi-memory-panel__summary-pill">
      <div className="pi-memory-panel__summary-label">{label}</div>
      <strong className="pi-memory-panel__summary-value">{value}</strong>
    </div>
  );
}

function MemoryCreateForm({ state }) {
  const draft = state.newDraft;
  return (
    <div className="pi-memory-panel__card">
      <h3 className="pi-memory-panel__form-title">手动补充可复用记忆</h3>
      <textarea
        className="form-control"
        placeholder="例如：某类故障的根因、修复方式和复验方法"
        rows={3}
        value={draft.content}
        onChange={(event) => state.updateNewDraft('content', event.target.value)}
      />
      <div className="pi-memory-panel__controls">
        <SmallInput label="memory_key" value={draft.memory_key} onChange={(value) => state.updateNewDraft('memory_key', value)} />
        <SmallSelect label="kind" value={draft.kind} values={MEMORY_KINDS} onChange={(value) => state.updateNewDraft('kind', value)} />
        <SmallSelect label="memory_type" value={draft.memory_type} values={MEMORY_TYPES} onChange={(value) => state.updateNewDraft('memory_type', value)} />
        <SmallSelect label="layer" value={draft.layer} values={MEMORY_LAYERS} onChange={(value) => state.updateNewDraft('layer', value)} />
        <SmallInput label="scope" value={draft.scope} onChange={(value) => state.updateNewDraft('scope', value)} />
        <SmallInput label="scope_id" value={draft.scope_id} onChange={(value) => state.updateNewDraft('scope_id', value)} />
        <SmallInput label="citation_type" value={draft.citation_type} onChange={(value) => state.updateNewDraft('citation_type', value)} />
        <SmallInput label="citation_id" value={draft.citation_id} onChange={(value) => state.updateNewDraft('citation_id', value)} />
        <SmallInput label="confidence" value={draft.confidence} onChange={(value) => state.updateNewDraft('confidence', value)} />
        <button className="btn btn-primary" onClick={state.create} disabled={Boolean(state.busy) || !draft.content.trim() || !draft.memory_key.trim()}>
          <Plus size={14} />添加
        </button>
      </div>
    </div>
  );
}

function MemoryList({ state }) {
  if (!state.loading && state.items.length === 0) {
    return <div className="pi-memory-panel__empty">暂无可复用记忆。</div>;
  }
  return <div className="pi-memory-panel__list">{state.items.map((item) => <MemoryCard key={item.id} item={item} state={state} />)}</div>;
}

function MemoryCard({ item, state }) {
  const draft = state.drafts[item.id] || draftFromItem(item);
  const disabled = Number(item.disabled) === 1;
  return (
    <article className="pi-memory-panel__card">
      <div className="pi-memory-panel__card-header">
        <strong>{item.memory_type || 'user'} / {item.kind}</strong>
        <span className={`pi-memory-panel__state${disabled ? ' is-disabled' : ''}`}>
          {disabled ? 'disabled' : 'active'} · {Number(item.pinned) === 1 ? 'pinned' : 'unpinned'} · {item.layer || 'long_term'} · {item.scope}:{item.scope_id || 'runner'} · seen {item.occurrence_count || 1}
        </span>
      </div>
      <textarea className="form-control" value={draft.content} onChange={(event) => state.updateDraft(item.id, 'content', event.target.value)} rows={3} />
      <div className="pi-memory-panel__controls">
        <SmallInput label="memory_key" value={draft.memory_key} onChange={(value) => state.updateDraft(item.id, 'memory_key', value)} />
        <SmallSelect label="kind" value={draft.kind} values={MEMORY_KINDS} onChange={(value) => state.updateDraft(item.id, 'kind', value)} />
        <SmallSelect label="memory_type" value={draft.memory_type} values={MEMORY_TYPES} onChange={(value) => state.updateDraft(item.id, 'memory_type', value)} />
        <SmallSelect label="layer" value={draft.layer} values={MEMORY_LAYERS} onChange={(value) => state.updateDraft(item.id, 'layer', value)} />
        <SmallInput label="confidence" value={draft.confidence} onChange={(value) => state.updateDraft(item.id, 'confidence', value)} />
        <SmallInput label="citation_type" value={draft.citation_type} onChange={(value) => state.updateDraft(item.id, 'citation_type', value)} />
        <SmallInput label="citation_id" value={draft.citation_id} onChange={(value) => state.updateDraft(item.id, 'citation_id', value)} />
        <button className="btn btn-secondary" onClick={() => state.action(item, 'save')} disabled={Boolean(state.busy)}><Save size={14} />保存</button>
        {Number(item.pinned) !== 1 && <button className="btn btn-secondary" onClick={() => state.action(item, 'pin')} disabled={Boolean(state.busy)}><Pin size={14} />Pin</button>}
        {disabled
          ? <button className="btn btn-secondary" onClick={() => state.action(item, 'enable')} disabled={Boolean(state.busy)}><Check size={14} />启用</button>
          : <button className="btn btn-secondary" onClick={() => state.action(item, 'disable')} disabled={Boolean(state.busy)}><XCircle size={14} />禁用</button>}
        <button className="btn btn-secondary" onClick={() => state.action(item, 'forget')} disabled={Boolean(state.busy)}><Trash2 size={14} />忘记</button>
      </div>
      <small className="pi-memory-panel__meta">
        source={item.source_type || '-'}:{item.source_id || '-'} · evidence={citationText(item)} · last_seen={item.last_seen_at || item.updated_at}
      </small>
    </article>
  );
}

function SmallInput({ label, onChange, value }) {
  return <label className="pi-memory-panel__small-field">{label}<input className="form-control pi-memory-panel__small-control" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SmallSelect({ label, onChange, value, values }) {
  return (
    <label className="pi-memory-panel__small-field">
      {label}
      <select className="form-control pi-memory-panel__small-control" value={value} onChange={(event) => onChange(event.target.value)}>
        {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select>
    </label>
  );
}

function draftFromItem(item) {
  return {
    citation_id: item.citation_id || '',
    citation_type: item.citation_type || '',
    confidence: item.confidence || 'medium',
    content: item.content || '',
    kind: item.kind || 'resolution',
    layer: item.layer || 'long_term',
    memory_key: item.memory_key || item.id,
    memory_type: item.memory_type || 'project'
  };
}

function defaultNewDraft() {
  return {
    citation_id: '', citation_type: 'manual', confidence: 'high', content: '',
    kind: 'resolution', layer: 'long_term', memory_key: '', memory_type: 'project',
    scope: 'project', scope_id: '', source_id: 'settings-memory-form', source_type: 'manual'
  };
}

function runMemoryAction(item, name, draft) {
  if (name === 'pin') return piMemoryApi.pin(item.id);
  if (name === 'enable') return piMemoryApi.enable(item.id);
  if (name === 'disable') return piMemoryApi.disable(item.id);
  if (name === 'forget') return piMemoryApi.forget(item.id);
  return piMemoryApi.update(item.id, draft);
}

function citationText(item) {
  const ref = [item.citation_type, item.citation_id].filter(Boolean).join(':');
  return [ref, item.citation_label || item.citation_url].filter(Boolean).join(' ') || '-';
}

const MEMORY_KINDS = ['user_preference', 'project_preference', 'decision', 'debugging_pattern', 'resolution', 'workflow', 'constraint'];
const MEMORY_TYPES = ['user', 'project', 'inbox', 'source', 'skill'];
const MEMORY_LAYERS = ['working', 'long_term'];
