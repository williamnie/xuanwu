import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

const DEFAULT_SETTINGS = {
  webhook_url: '',
  events: ['done', 'failed'],
  active_start: '',
  active_end: '',
};

const EVENT_OPTIONS = [
  { value: 'done', label: 'Issue Done' },
  { value: 'failed', label: 'Issue Failed' },
];

const formStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(240px, 1.4fr) 1fr auto',
  gap: '12px',
  alignItems: 'end',
};

const eventOptionStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '0.82rem',
};

export default function NotificationSettingsPanel() {
  const controls = useNotificationSettings();

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader />
      {controls.error && <ErrorText text={controls.error} />}
      <SettingsBody {...controls} />
    </section>
  );
}

function useNotificationSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    loadNotificationSettings(alive, setSettings, setError, setLoading);
    return () => { alive = false; };
  }, []);

  const updateField = (field, value) => {
    setSettings(current => ({ ...current, [field]: value }));
  };
  const toggleEvent = (event, checked) => {
    setSettings(current => ({ ...current, events: nextEvents(current.events, event, checked) }));
  };
  const handleSubmit = async (submitEvent) => {
    submitEvent.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateNotificationSettings(settings);
      setSettings(normalizeSettings(updated));
      message.success('通知设置已保存');
    } catch (err) {
      setError(err.message || '保存通知设置失败');
    } finally {
      setSaving(false);
    }
  };

  return { settings, loading, saving, error, updateField, toggleEvent, handleSubmit };
}

function PanelHeader() {
  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Bell size={18} color="var(--primary)" /> 通知
      </h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
        issue 进入 done / failed 后发送 webhook；通知失败只写入 issue 日志，不影响 runner。
      </p>
    </div>
  );
}

function ErrorText({ text }) {
  return <div style={{ color: 'var(--error)', fontSize: '0.78rem' }}>{text}</div>;
}

function SettingsBody({ loading, settings, saving, updateField, toggleEvent, handleSubmit }) {
  if (loading) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>加载中...</div>;
  }
  return (
    <form onSubmit={handleSubmit} style={formStyle}>
      <WebhookField value={settings.webhook_url} onChange={value => updateField('webhook_url', value)} />
      <ActiveHoursFields settings={settings} updateField={updateField} />
      <button className="btn btn-primary" style={{ padding: '8px 14px' }} disabled={saving}>
        {saving ? '保存中...' : '保存通知'}
      </button>
      <EventFields events={settings.events} onToggle={toggleEvent} />
    </form>
  );
}

function WebhookField({ value, onChange }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>Webhook URL</label>
      <input
        className="form-control"
        type="url"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://example.com/codex-issue-webhook"
      />
    </div>
  );
}

function ActiveHoursFields({ settings, updateField }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label>通知时间段</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <TimeInput value={settings.active_start} onChange={value => updateField('active_start', value)} />
        <TimeInput value={settings.active_end} onChange={value => updateField('active_end', value)} />
      </div>
    </div>
  );
}

function TimeInput({ value, onChange }) {
  return (
    <input
      className="form-control"
      type="time"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function EventFields({ events, onToggle }) {
  return (
    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
      {EVENT_OPTIONS.map(option => (
        <label key={option.value} style={eventOptionStyle}>
          <input
            type="checkbox"
            checked={events.includes(option.value)}
            onChange={(event) => onToggle(option.value, event.target.checked)}
          />
          {option.label}
        </label>
      ))}
      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        留空时间段表示全天可通知；跨午夜时间段也支持。
      </span>
    </div>
  );
}

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value || {}),
    events: Array.isArray(value?.events) ? value.events : DEFAULT_SETTINGS.events,
  };
}

function nextEvents(events, event, checked) {
  if (checked) return [...new Set([...events, event])];
  return events.filter(item => item !== event);
}

function loadNotificationSettings(alive, setSettings, setError, setLoading) {
  api.getNotificationSettings()
    .then(data => { if (alive) setSettings(normalizeSettings(data)); })
    .catch(err => { if (alive) setError(err.message || '加载通知设置失败'); })
    .finally(() => { if (alive) setLoading(false); });
}
