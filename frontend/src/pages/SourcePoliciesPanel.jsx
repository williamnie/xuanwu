import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

const PROFILES = ['company_chat', 'personal_chat', 'ops_chat', 'private_dm', 'email', 'github', 'custom'];
const INTAKE_MODES = ['manual_only', 'mention_only', 'scheduled_llm_triage', 'continuous_llm_triage'];
const ACTION_MODES = ['observe_only', 'draft_only', 'propose_actions', 'auto_low_risk'];

export default function SourcePoliciesPanel() {
  const [state, setState] = useState({ data: null, error: '', loading: true, saving: false });
  const [selectedId, setSelectedId] = useState('');
  const automations = useMemo(() => state.data?.automations || [], [state.data]);
  const profiles = useMemo(() => state.data?.profiles || [], [state.data]);
  const selected = useMemo(() => automations.find((item) => String(item.id) === selectedId) || automations[0], [automations, selectedId]);
  const [form, setForm] = useState(defaultForm());

  useEffect(() => { loadPolicies(setState); }, []);
  useEffect(() => { if (selected) setSelectedId(String(selected.id)); }, [selected]);
  useEffect(() => { setForm(draftFromPolicy(selected?.source_policy || selected?.effective_policy)); }, [selected]);

  return (
    <section className="glass-card" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={() => loadPolicies(setState)} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      <PolicyLayers layers={state.data?.layers || []} />
      <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(220px, 0.75fr) minmax(280px, 1.5fr)' }}>
        <PolicyList automations={automations} profiles={profiles} selectedId={selectedId} onSelect={setSelectedId} />
        <PolicyEditor
          form={form}
          hasSelection={Boolean(selected)}
          saving={state.saving}
          setForm={setForm}
          onCreate={() => createPolicy(form, setState)}
          onSave={() => savePolicy(selected, form, setState)}
        />
      </div>
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
      <div>
        <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', fontWeight: 700, gap: '8px' }}>
          <ShieldCheck size={18} color="var(--primary)" /> Source Policy
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          管理 source profile、intake/action mode、外部回复 allowlist，以及 issue.create / enqueue 的确认策略。
        </p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function PolicyLayers({ layers }) {
  if (!layers.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {layers.map((layer, index) => (
        <span key={layer.scope} style={pillStyle(layer.writable)}>
          {index + 1}. {layer.scope}{layer.writable ? ' · editable' : ''}
        </span>
      ))}
    </div>
  );
}

function PolicyList({ automations, onSelect, profiles, selectedId }) {
  return (
    <aside style={{ display: 'grid', gap: '10px' }}>
      <strong style={{ fontSize: '0.88rem' }}>Editable automation policies</strong>
      {automations.length === 0 && <EmptyPolicyList />}
      {automations.map((item) => (
        <button className="btn btn-secondary" key={item.id} onClick={() => onSelect(String(item.id))} style={listButtonStyle(String(item.id) === selectedId)} type="button">
          <span style={{ fontWeight: 800 }}>{item.name}</span>
          <small style={{ color: 'var(--text-muted)' }}>{item.trigger_type} · {item.effective_policy?.profile || 'custom'}</small>
        </button>
      ))}
      <strong style={{ fontSize: '0.88rem', marginTop: '6px' }}>Read-only source profiles</strong>
      {(profiles || []).map((profile) => <span key={profile.id} style={pillStyle(false)}>{profile.id} · {profile.policy?.action_mode}</span>)}
    </aside>
  );
}

function EmptyPolicyList() {
  return (
    <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5 }}>
      暂无 automation-owned source policy；可先创建一个禁用的 policy-only 记录，再按来源接入 automation。
    </div>
  );
}

function PolicyEditor({ form, hasSelection, onCreate, onSave, saving, setForm }) {
  return (
    <main style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: '14px', display: 'grid', gap: '12px', padding: '14px' }}>
      <EditorGrid form={form} setForm={setForm} />
      <ReplyPolicyFields form={form} setForm={setForm} />
      <IssuePolicyFields form={form} setForm={setForm} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button className="btn btn-primary" disabled={saving || !hasSelection} onClick={onSave} type="button">
          <Save size={15} /> 保存选中 policy
        </button>
        <button className="btn btn-secondary" disabled={saving} onClick={onCreate} type="button">
          <Plus size={15} /> 创建 policy-only 记录
        </button>
      </div>
      <small style={{ color: 'var(--text-muted)' }}>
        默认安全：external reply 需要显式启用并命中 allowlist；issue.create / enqueue 未开启策略时仍需确认。
      </small>
    </main>
  );
}

function EditorGrid({ form, setForm }) {
  return (
    <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
      <SelectField label="profile" name="profile" options={PROFILES} form={form} setForm={setForm} />
      <SelectField label="intake_mode" name="intake_mode" options={INTAKE_MODES} form={form} setForm={setForm} />
      <SelectField label="action_mode" name="action_mode" options={ACTION_MODES} form={form} setForm={setForm} />
      <CheckboxField label="collect_raw_events" name="collect_raw_events" form={form} setForm={setForm} />
    </div>
  );
}

function ReplyPolicyFields({ form, setForm }) {
  return (
    <Fieldset title="Reply policy">
      <CheckboxField label="auto_reply_enabled" name="auto_reply_enabled" form={form} setForm={setForm} />
      <CheckboxField label="require_approval_for_external_reply" name="require_approval_for_external_reply" form={form} setForm={setForm} />
      <TextField label="allowed_chats" name="allowed_chats" form={form} setForm={setForm} />
      <TextField label="allowed_people" name="allowed_people" form={form} setForm={setForm} />
    </Fieldset>
  );
}

function IssuePolicyFields({ form, setForm }) {
  return (
    <Fieldset title="Issue policy">
      <CheckboxField label="auto_create_triage_issue" name="auto_create_triage_issue" form={form} setForm={setForm} />
      <CheckboxField label="auto_enqueue" name="auto_enqueue" form={form} setForm={setForm} />
      <CheckboxField label="require_project_confirmation" name="require_project_confirmation" form={form} setForm={setForm} />
    </Fieldset>
  );
}

function Fieldset({ children, title }) {
  return <div style={{ borderTop: '1px solid var(--border-light)', display: 'flex', flexWrap: 'wrap', gap: '10px', paddingTop: '10px' }}><strong style={{ flex: '1 0 100%', fontSize: '0.82rem' }}>{title}</strong>{children}</div>;
}

function SelectField({ form, label, name, options, setForm }) {
  return <label style={fieldStyle()}>{label}<select className="form-control" value={form[name]} onChange={(event) => setForm({ ...form, [name]: event.target.value })}>{options.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>;
}

function TextField({ form, label, name, setForm }) {
  return <label style={fieldStyle()}>{label}<input className="form-control" placeholder="逗号分隔" value={form[name]} onChange={(event) => setForm({ ...form, [name]: event.target.value })} /></label>;
}

function CheckboxField({ form, label, name, setForm }) {
  return <label style={{ alignItems: 'center', color: 'var(--text-secondary)', display: 'flex', fontSize: '0.8rem', gap: '7px' }}><input checked={Boolean(form[name])} onChange={(event) => setForm({ ...form, [name]: event.target.checked })} type="checkbox" />{label}</label>;
}

function defaultForm() {
  return {
    action_mode: 'observe_only',
    allowed_chats: '',
    allowed_people: '',
    auto_create_triage_issue: false,
    auto_enqueue: false,
    auto_reply_enabled: false,
    collect_raw_events: true,
    intake_mode: 'manual_only',
    profile: 'custom',
    require_approval_for_external_reply: true,
    require_project_confirmation: true
  };
}

function draftFromPolicy(policy = {}) {
  const reply = policy.reply_policy || {};
  const issue = policy.issue_policy || {};
  return {
    ...defaultForm(),
    action_mode: policy.action_mode || 'observe_only',
    allowed_chats: (reply.allowed_chats || []).join(', '),
    allowed_people: (reply.allowed_people || []).join(', '),
    auto_create_triage_issue: Boolean(issue.auto_create_triage_issue),
    auto_enqueue: Boolean(issue.auto_enqueue),
    auto_reply_enabled: Boolean(reply.auto_reply_enabled),
    collect_raw_events: policy.collect_raw_events !== false,
    intake_mode: policy.intake_mode || 'manual_only',
    profile: policy.profile || 'custom',
    require_approval_for_external_reply: reply.require_approval_for_external_reply !== false,
    require_project_confirmation: issue.require_project_confirmation !== false
  };
}

function policyFromForm(form) {
  return {
    action_mode: form.action_mode,
    collect_raw_events: Boolean(form.collect_raw_events),
    intake_mode: form.intake_mode,
    issue_policy: {
      auto_create_triage_issue: Boolean(form.auto_create_triage_issue),
      auto_enqueue: Boolean(form.auto_enqueue),
      require_project_confirmation: Boolean(form.require_project_confirmation)
    },
    profile: form.profile,
    reply_policy: {
      allowed_chats: listFromText(form.allowed_chats),
      allowed_people: listFromText(form.allowed_people),
      auto_reply_enabled: Boolean(form.auto_reply_enabled),
      require_approval_for_external_reply: Boolean(form.require_approval_for_external_reply)
    }
  };
}

function loadPolicies(setState) {
  setState((previous) => ({ ...previous, loading: true }));
  api.getPiSourcePolicies()
    .then((data) => setState({ data, error: '', loading: false, saving: false }))
    .catch((error) => setState((previous) => ({ ...previous, error: error.message || '读取 source policies 失败', loading: false })));
}

async function savePolicy(selected, form, setState) {
  if (!selected) return;
  await runPolicyWrite(setState, () => api.updatePiAutomationSourcePolicy(selected.id, { source_policy: policyFromForm(form) }), 'Source policy 已保存');
}

async function createPolicy(form, setState) {
  await runPolicyWrite(setState, () => api.createPiSourcePolicy({ source_policy: policyFromForm(form) }), 'Source policy 记录已创建');
}

async function runPolicyWrite(setState, write, successText) {
  setState((previous) => ({ ...previous, saving: true }));
  try {
    await write();
    message.success(successText);
    await loadPolicies(setState);
  } catch (error) {
    message.error(error.message || 'Source policy 更新失败');
    setState((previous) => ({ ...previous, saving: false }));
  }
}

function listFromText(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function fieldStyle() {
  return { color: 'var(--text-muted)', display: 'grid', fontSize: '0.78rem', gap: '5px' };
}

function listButtonStyle(active) {
  return {
    alignItems: 'flex-start',
    background: active ? 'color-mix(in srgb, var(--primary) 12%, var(--bg-card))' : undefined,
    display: 'grid',
    gap: '3px',
    justifyItems: 'start',
    textAlign: 'left'
  };
}

function pillStyle(editable) {
  return {
    background: editable ? 'var(--success-glow)' : 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '999px',
    color: editable ? 'var(--success)' : 'var(--text-muted)',
    fontSize: '0.76rem',
    fontWeight: 800,
    padding: '6px 10px'
  };
}
