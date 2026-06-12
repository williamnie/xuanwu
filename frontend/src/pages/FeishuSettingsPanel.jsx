import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

const DEFAULT_FORM = {
  allowed_chat_ids: '',
  allowed_user_ids: '',
  app_id: '',
  app_secret: '',
  encrypt_key: '',
  project_mappings: '',
  verification_token: '',
};

const fieldGridStyle = {
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
};

export default function FeishuSettingsPanel() {
  const state = useFeishuSettings();
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader status={state.remote?.status} enabled={state.remote?.enabled} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.82rem' }}>{state.error}</div>}
      <SettingsForm {...state} />
    </section>
  );
}

function useFeishuSettings() {
  const [error, setError] = useState('');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [remote, setRemote] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadSettings = () => loadFeishuSettings(setRemote, setForm, setError, setLoading);
  const updateField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const handleSubmit = (event) => saveFeishuSettings(event, { form, setError, setForm, setRemote, setSaving });

  useEffect(() => {
    loadSettings();
  }, []);

  return { error, form, handleSubmit, loading, remote, saving, updateField };
}

function PanelHeader({ enabled, status }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={18} color="var(--primary)" /> 飞书 Bot
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          配置企业自建应用的事件回调与自动回复凭据；保存到本机 runner-settings.local.json，不写入仓库。
        </p>
      </div>
      <StatusPill enabled={enabled} status={status} />
    </div>
  );
}

function StatusPill({ enabled, status }) {
  const text = enabled ? 'configured' : status || 'disabled';
  return (
    <span style={{ alignItems: 'center', border: '1px solid var(--border-light)', borderRadius: '999px', display: 'inline-flex', fontSize: '0.76rem', gap: '6px', padding: '6px 10px' }}>
      <span className={`status-dot ${enabled ? 'active' : 'idle'}`} style={{ height: '7px', width: '7px' }} />
      {text}
    </span>
  );
}

function SettingsForm({ form, loading, remote, saving, updateField, handleSubmit }) {
  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>加载飞书配置...</div>;
  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <CallbackHint callbackPath={remote?.callback_path} settingsFile={remote?.settings_file} />
      <div style={fieldGridStyle}>
        <TextField label="App ID" value={form.app_id} onChange={(value) => updateField('app_id', value)} placeholder="cli_xxx" />
        <SecretField configured={remote?.app_secret_configured} label="App Secret" value={form.app_secret} onChange={(value) => updateField('app_secret', value)} />
        <SecretField configured={remote?.verification_token_configured} label="Verification Token" value={form.verification_token} onChange={(value) => updateField('verification_token', value)} />
        <SecretField configured={remote?.encrypt_key_configured} label="Encrypt Key" optional value={form.encrypt_key} onChange={(value) => updateField('encrypt_key', value)} />
        <TextField label="Allowed Chat IDs" value={form.allowed_chat_ids} onChange={(value) => updateField('allowed_chat_ids', value)} placeholder="oc_xxx, oc_yyy" />
        <TextField label="Allowed User IDs" value={form.allowed_user_ids} onChange={(value) => updateField('allowed_user_ids', value)} placeholder="ou_xxx, ou_yyy" />
      </div>
      <TextAreaField label="Project Mappings" value={form.project_mappings} onChange={(value) => updateField('project_mappings', value)} placeholder="chat:oc_xxx=codex-runner,user:ou_xxx=codex-runner" />
      <Footer remote={remote} saving={saving} />
    </form>
  );
}

function CallbackHint({ callbackPath, settingsFile }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px' }}>
      <div style={{ alignItems: 'center', display: 'flex', gap: '8px', fontWeight: 700 }}>
        <KeyRound size={15} color="var(--primary)" /> 飞书开放平台回调
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '6px', wordBreak: 'break-all' }}>
        Request URL 填：<code>{callbackPath || '/api/integrations/feishu/events'}</code>；本地配置文件：<code>{settingsFile || 'runner-settings.local.json'}</code>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label className="form-group" style={{ marginBottom: 0 }}>
      <span>{label}</span>
      <input className="form-control" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function SecretField({ configured, label, onChange, optional = false, value }) {
  return (
    <label className="form-group" style={{ marginBottom: 0 }}>
      <span>{label} {optional && <small style={{ color: 'var(--text-muted)' }}>(可选)</small>}</span>
      <input className="form-control" type="password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? '已配置，留空不覆盖' : '未配置'} />
    </label>
  );
}

function TextAreaField({ label, onChange, placeholder, value }) {
  return (
    <label className="form-group" style={{ marginBottom: 0 }}>
      <span>{label}</span>
      <textarea className="form-control" rows={2} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function Footer({ remote, saving }) {
  const missing = remote?.missing_required || [];
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div style={{ color: missing.length ? 'var(--warning)' : 'var(--text-muted)', fontSize: '0.78rem' }}>
        {missing.length ? `缺少：${missing.join(', ')}` : <><CheckCircle2 size={14} /> 飞书必填凭据已配置</>}
      </div>
      <button className="btn btn-primary" disabled={saving}>{saving ? '保存中...' : '保存飞书 Bot'}</button>
    </div>
  );
}

async function loadFeishuSettings(setRemote, setForm, setError, setLoading) {
  setLoading(true);
  try {
    const data = await api.getFeishuSettings();
    setRemote(data);
    setForm(formFromRemote(data));
    setError('');
  } catch (err) {
    setError(err.message || '加载飞书配置失败');
  } finally {
    setLoading(false);
  }
}

async function saveFeishuSettings(event, state) {
  event.preventDefault();
  state.setSaving(true);
  state.setError('');
  try {
    const data = await api.updateFeishuSettings(payloadFromForm(state.form));
    state.setRemote(data);
    state.setForm(formFromRemote(data));
    message.success('飞书 Bot 配置已保存');
  } catch (err) {
    state.setError(err.message || '保存飞书配置失败');
  } finally {
    state.setSaving(false);
  }
}

function formFromRemote(data) {
  return {
    ...DEFAULT_FORM,
    allowed_chat_ids: (data?.allowed_chat_ids || []).join(', '),
    allowed_user_ids: (data?.allowed_user_ids || []).join(', '),
    app_id: data?.app_id || '',
    project_mappings: data?.project_mappings || '',
  };
}

function payloadFromForm(form) {
  return {
    ...form,
    allowed_chat_ids: form.allowed_chat_ids,
    allowed_user_ids: form.allowed_user_ids,
  };
}
