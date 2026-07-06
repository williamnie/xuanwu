import { useEffect, useMemo, useState } from 'react';
import { Archive, Bot, RefreshCw, Search, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import './AttentionInbox.css';

const STATUSES = ['', 'new', 'triaged', 'proposal_created', 'actioned', 'ignored', 'failed'];
const STATUS_LABELS = {
  '': 'All',
  new: 'New',
  triaged: 'Triaged',
  proposal_created: 'Proposal',
  actioned: 'Actioned',
  ignored: 'Ignored',
  failed: 'Failed',
};

export default function AttentionInbox() {
  const [status, setStatus] = useState('new');
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(0);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState('');
  const [busy, setBusy] = useState('');
  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId) || items[0] || null, [items, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getPiAttentionItems({ status, limit: 100 })
      .then((rows) => {
        if (cancelled) return;
        setUnavailable('');
        setItems(rows || []);
        setSelectedId((current) => rows?.some((item) => item.id === current) ? current : rows?.[0]?.id || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) {
          setUnavailable('当前 runtime 尚未启用 Inbox API；这是 PI Assistant Inbox 的预留入口，升级后会显示 intake items。');
          setItems([]);
          setSelectedId(0);
          return;
        }
        message.error(err.message || '加载 Inbox 失败');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [status]);

  useEffect(() => {
    if (!selectedItem) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    loadDetail(selectedItem.id)
      .then((next) => !cancelled && setDetail(next))
      .catch((err) => message.error(err.message || '加载 Inbox item 详情失败'));
    return () => { cancelled = true; };
  }, [selectedItem]);

  const refreshItems = () => api.getPiAttentionItems({ status, limit: 100 }).then((rows) => setItems(rows || []));
  const runAction = async (label, action) => {
    if (!selectedItem) return;
    setBusy(label);
    try {
      await action(selectedItem.id);
      await refreshItems();
      const next = await loadDetail(selectedItem.id);
      setDetail(next);
      message.success('Inbox item 已更新');
    } catch (err) {
      message.error(err.message || 'Inbox item 操作失败');
    } finally {
      setBusy('');
    }
  };
  const resolveProposal = async (proposal, action, payload) => {
    if (!selectedItem) return;
    setBusy(`${action}-${proposal.id}`);
    try {
      await payload();
      await refreshItems();
      setDetail(await loadDetail(selectedItem.id));
      message.success(action === 'approve' ? 'Proposal 已批准并执行' : 'Proposal 已拒绝');
    } catch (err) {
      message.error(err.message || 'Proposal 操作失败');
    } finally {
      setBusy('');
    }
  };
  const approveProposal = (proposal, edits) => resolveProposal(proposal, 'approve', () => (
    api.approvePiActionProposal(proposal.id, { action_edits: edits, actor: 'user' })
  ));
  const rejectProposal = (proposal) => resolveProposal(proposal, 'reject', () => (
    api.rejectPiActionProposal(proposal.id, { actor: 'user', reason: 'Rejected from Attention Inbox' })
  ));

  return (
    <div className="attention-inbox-page">
      <section className="attention-inbox-hero">
        <div>
          <p className="eyebrow">PI Assistant</p>
          <h1>Inbox</h1>
          <p>处理事项视图：从 raw event、context bundle、intake run 追溯 PI 为什么认为它需要关注。</p>
        </div>
        <div className="attention-inbox-filter" aria-label="状态筛选">
          {STATUSES.map((value) => (
            <button key={value || 'all'} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>
              {STATUS_LABELS[value]}
            </button>
          ))}
        </div>
      </section>

      <div className="attention-inbox-grid">
        <aside className="attention-inbox-list">
          <div className="attention-list-head"><Search size={15} /> Items · {items.length}</div>
          {loading ? <EmptyState text="加载中…" /> : unavailable ? <EmptyState text={unavailable} /> : items.length === 0 ? <EmptyState text="当前筛选没有 item" /> : items.map((item) => (
            <ItemRow key={item.id} item={item} active={item.id === selectedItem?.id} onClick={() => setSelectedId(item.id)} />
          ))}
        </aside>

        <main className="attention-inbox-detail">
          {unavailable ? <EmptyState text="Inbox API coming soon；不会创建 issue、enqueue 或外部回复。" /> : !selectedItem ? <EmptyState text="选择一个 Inbox item 查看证据" /> : (
            <>
              <DetailHeader item={selectedItem} />
              <div className="attention-actions">
                <button disabled={!!busy} onClick={() => runAction('triage', (id) => api.updatePiAttentionItem(id, { status: 'triaged' }))}>Mark triaged</button>
                <button disabled={!!busy} onClick={() => runAction('domain', api.startPiAttentionDomainSkill)}><Sparkles size={14} /> Domain skill</button>
                <button disabled={!!busy} onClick={() => runAction('reintake', api.reintakePiAttentionItem)}><RefreshCw size={14} /> Re-intake</button>
                <button disabled={!!busy} onClick={() => runAction('ignore', api.ignorePiAttentionItem)}><Archive size={14} /> Ignore</button>
              </div>
              <IntentPanel item={detail?.item || selectedItem} />
              <ProposalPanel
                busy={busy}
                onApprove={approveProposal}
                onReject={rejectProposal}
                proposals={detail?.proposals || []}
              />
              <EvidencePanel detail={detail} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

async function loadDetail(id) {
  const item = await api.getPiAttentionItem(id);
  const eventIds = rawEventIds(item);
  const sourceItemId = `attention_inbox_item:${item.id}`;
  const [bundle, intakeRun, proposals, rawEvents] = await Promise.all([
    api.getPiAttentionContextBundle(item.bundle_id),
    api.getPiAttentionIntakeRun(item.intake_run_id),
    api.getPiActionProposals({ sourceItemId }),
    Promise.all(eventIds.map((eventId) => api.getPiAttentionRawEvent(eventId))),
  ]);
  return { bundle, intakeRun, item, proposals: proposals || [], rawEvents };
}

function rawEventIds(item) {
  const fromLinks = (item.links?.raw_events || []).map((href) => Number(String(href).split('/').pop())).filter(Boolean);
  const fromRefs = (item.evidence_refs || []).map((ref) => /^external_event:(\d+)/.exec(ref)?.[1]).filter(Boolean).map(Number);
  return [...new Set([...fromLinks, ...fromRefs])];
}

function ItemRow({ item, active, onClick }) {
  return (
    <button className={`attention-item-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className={`status-pill ${item.status}`}>{item.status}</span>
      <strong>{item.title}</strong>
      <small>{item.primary_intent} · {Math.round((item.confidence || 0) * 100)}%</small>
      <p>{item.summary}</p>
    </button>
  );
}

function DetailHeader({ item }) {
  return (
    <header className="attention-detail-header">
      <div>
        <p className="eyebrow">#{item.id} · {item.source}</p>
        <h2>{item.title}</h2>
        <p>{item.summary}</p>
      </div>
      <span className={`status-pill ${item.status}`}>{item.status}</span>
    </header>
  );
}

function IntentPanel({ item }) {
  const projectHints = item.project_hints || item.target_hints || [];
  return (
    <section className="attention-card">
      <h3><Bot size={16} /> Intent & next step</h3>
      <div className="chip-row"><Chip label={item.primary_intent} strong />{(item.secondary_intents || []).map((intent) => <Chip key={intent} label={intent} />)}</div>
      <p className="muted">Proposal status: {item.status === 'proposal_created' ? 'created' : 'not created'}</p>
      <EvidenceRefs refs={item.evidence_refs || []} />
      <ChipGroup title="Suggested actions" values={item.suggested_actions || []} />
      <ChipGroup title="Project hints" values={projectHints.map((hint) => hint.label || hint.id || hint.kind)} />
    </section>
  );
}

function ProposalPanel({ busy, onApprove, onReject, proposals }) {
  if (!proposals.length) {
    return <section className="attention-card"><p className="muted">Action proposal: not created yet.</p></section>;
  }
  return (
    <section className="attention-card proposal-card">
      <h3>Action proposal</h3>
      {proposals.map((proposal) => (
        <ProposalItem
          busy={busy}
          key={proposal.id}
          onApprove={onApprove}
          onReject={onReject}
          proposal={proposal}
        />
      ))}
    </section>
  );
}

function ProposalItem({ busy, onApprove, onReject, proposal }) {
  const [drafts, setDrafts] = useState(() => draftMap(proposal));
  useEffect(() => setDrafts(draftMap(proposal)), [proposal]);
  const pending = proposal.status === 'proposed';
  const edits = () => Object.fromEntries(Object.entries(drafts).map(([id, draftText]) => [id, { payload: { draft: draftText } }]));
  return (
    <div className="proposal-item">
      <div className="proposal-head">
        <div>
          <strong>{proposal.summary}</strong>
          <p className="muted">Skill run: {proposal.skill_run_id} · confidence {Math.round((proposal.confidence || 0) * 100)}%</p>
        </div>
        <span className={`status-pill ${proposal.status}`}>{proposal.status}</span>
      </div>
      <EvidenceRefs refs={proposal.evidence_refs || []} />
      <div className="proposal-actions-list">
        {(proposal.actions || []).map((action) => (
          <ProposalAction
            action={action}
            draftText={drafts[action.id] || ''}
            key={action.id}
            onDraftChange={(value) => setDrafts((current) => ({ ...current, [action.id]: value }))}
          />
        ))}
      </div>
      <div className="attention-actions">
        <button disabled={!pending || !!busy} onClick={() => onApprove(proposal, edits())}>Approve & execute</button>
        <button disabled={!pending || !!busy} onClick={() => onReject(proposal)}>Reject</button>
      </div>
    </div>
  );
}

function ProposalAction({ action, draftText, onDraftChange }) {
  return (
    <div className="proposal-action-row">
      <div>
        <strong>{action.type}</strong>
        <p className="muted">Risk: {action.risk} · approval: {action.requires_approval ? 'required' : 'not required'} · status: {action.execution_status || 'queued after approval'}</p>
        {action.summary ? <p>{action.summary}</p> : null}
      </div>
      {action.type === 'message.reply_draft' ? (
        <label className="proposal-draft-field">
          <span>Reply draft</span>
          <textarea value={draftText} onChange={(event) => onDraftChange(event.target.value)} />
        </label>
      ) : <pre>{JSON.stringify(action.payload || {}, null, 2)}</pre>}
    </div>
  );
}

function EvidencePanel({ detail }) {
  if (!detail) return <section className="attention-card"><p className="muted">证据加载中…</p></section>;
  return (
    <section className="attention-card evidence-stack">
      <h3>Evidence trace</h3>
      <details open>
        <summary>Context bundle #{detail.bundle.id}</summary>
        <pre>{JSON.stringify(detail.bundle, null, 2)}</pre>
      </details>
      <details>
        <summary>Intake run #{detail.intakeRun.id} · {detail.intakeRun.status}</summary>
        <pre>{JSON.stringify(detail.intakeRun, null, 2)}</pre>
      </details>
      {detail.rawEvents.map((event) => <RawEventDetails key={event.id} event={event} />)}
    </section>
  );
}

function draftMap(proposal) {
  return Object.fromEntries((proposal.actions || [])
    .filter((action) => action.type === 'message.reply_draft')
    .map((action) => [action.id, action.payload?.draft || action.payload?.content || '']));
}

function RawEventDetails({ event }) {
  return (
    <details>
      <summary>Raw event #{event.id} · {event.source}:{event.external_id}</summary>
      <p>{event.content}</p>
      <details>
        <summary>Attachments · {(event.attachments || []).length}</summary>
        <pre>{JSON.stringify(event.attachments || [], null, 2)}</pre>
      </details>
      <details>
        <summary>raw_json</summary>
        <pre>{JSON.stringify(event.raw_json || {}, null, 2)}</pre>
      </details>
    </details>
  );
}

function EvidenceRefs({ refs }) {
  return <ChipGroup title="Evidence refs" values={refs} />;
}

function ChipGroup({ title, values }) {
  if (!values.length) return null;
  return <div className="chip-block"><span>{title}</span><div className="chip-row">{values.map((value) => <Chip key={value} label={value} />)}</div></div>;
}

function Chip({ label, strong = false }) {
  return <span className={`attention-chip ${strong ? 'strong' : ''}`}>{label}</span>;
}

function EmptyState({ text }) {
  return <div className="attention-empty">{text}</div>;
}
