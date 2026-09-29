import { assistantApi } from '../api/assistant.js';
import { connectorsApi } from '../api/connectors.js';
import { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCircle2, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import { message } from '../store/toastStore';
import { PanelLoader } from '../components/TurtleLoader';
import { buildNotificationPreferencePayload } from './settingsProductModels.js';

const NOTIFY_OPTIONS = [
  ['needs_user', '需要你处理'],
  ['budget_exhausted', '预算耗尽'],
  ['unsafe_or_external', '外部操作或安全风险'],
  ['actionable', '可立即处理'],
  ['warning', '一般告警'],
  ['info', '普通状态'],
];

export default function NotificationSettingsPanel() {
  const state = useNotificationSettings();
  return (
    <section className="glass-card settings-notification-panel">
      <NotificationHeader loading={state.loading} onRefresh={state.load} />
      {state.error && <div className="settings-inline-error" role="alert">{state.error}</div>}
      {state.loading && state.preferences.length === 0
        ? <PanelLoader label="正在读取通知偏好…" />
        : <NotificationForm state={state} />}
      <PreferenceHistory disabling={state.disabling} onDisable={state.disable} preferences={state.preferences} />
    </section>
  );
}

function useNotificationSettings() {
  const [error, setError] = useState('');
  const [form, setForm] = useState(defaultNotificationForm);
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState([]);
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState('');
  const [connectors, setConnectors] = useState([]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, connectorData] = await Promise.all([
        assistantApi.getPiGuardianPreferences({ scope: 'global' }),
        connectorsApi.getPiConnectors(),
      ]);
      const next = Array.isArray(data) ? data : [];
      setPreferences(next);
      setConnectors(connectorData?.connectors || []);
      setForm(formFromPreference(next.find(item => item.status === 'active')));
      setError('');
    } catch (loadError) {
      setError(loadError.message || '读取通知偏好失败');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const updateField = (field, value) => setForm(current => ({ ...current, [field]: value }));
  const toggleNotifyOn = token => setForm(current => ({
    ...current,
    notifyOn: current.notifyOn.includes(token) ? current.notifyOn.filter(item => item !== token) : [...current.notifyOn, token],
  }));
  return {
    disable: preference => disablePreference(preference, load, setDisabling, setError),
    disabling,
    connectors,
    error,
    form,
    load,
    loading,
    preferences,
    save: event => savePreference(event, form, load, setError, setSaving),
    saving,
    toggleNotifyOn,
    updateField,
  };
}

function NotificationHeader({ loading, onRefresh }) {
  return (
    <div className="settings-product-header">
      <div>
        <h2><BellRing size={18} color="var(--primary)" /> 通知渠道与偏好</h2>
        <p>选择普通消息的通知方式，并查看通知渠道是否已连接。保存为全局偏好，历史设置会保留在下方。</p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />刷新
      </button>
    </div>
  );
}

function NotificationForm({ state }) {
  return (
    <form className="settings-notification-form" onSubmit={state.save}>
      <div className="settings-notification-grid">
        <label className="form-group">
          <span>通知方式</span>
          <select className="form-control" value={state.form.mode} onChange={event => state.updateField('mode', event.target.value)}>
            <option value="normal">及时通知 · 普通消息立即发送</option>
            <option value="digest">汇总通知 · 合并普通消息</option>
            <option value="quiet">安静模式 · 普通消息静默或延后</option>
            <option value="verbose">详细通知 · 接收更多普通消息</option>
          </select>
        </label>
        <NotificationChannels connectors={state.connectors} />
      </div>
      <fieldset className="settings-notify-options">
        <legend>额外立即通知</legend>
        {NOTIFY_OPTIONS.map(([token, label]) => (
          <label key={token}>
            <input checked={state.form.notifyOn.includes(token)} onChange={() => state.toggleNotifyOn(token)} type="checkbox" />
            <span>{label}<code>{token}</code></span>
          </label>
        ))}
      </fieldset>
      <div className="settings-notification-safety"><ShieldAlert size={15} /> <strong>重要提醒：</strong>紧急事项、需要你处理的操作、预算耗尽和有安全风险的外部操作，仍可能立即通知。通知偏好不能关闭审批或解除执行限制。</div>
      <button className="btn btn-primary" disabled={state.saving} type="submit"><Save size={15} />{state.saving ? '保存中…' : '保存通知偏好'}</button>
    </form>
  );
}

function NotificationChannels({ connectors }) {
  const channels = ['feishu', 'telegram'].map(id => connectors.find(connector => connector.id === id) || { id, status: 'disabled' });
  return (
    <div className="settings-channel-picker">
      <span>通知渠道</span>
      <label><CheckCircle2 size={15} color="var(--success)" /> 玄武页面 <small>本地通知始终可用</small></label>
      {channels.map(channel => {
        const ready = channel.status === 'configured';
        return <label key={channel.id}>
          <span className={`status-dot ${ready ? 'active' : 'idle'}`} />
          {channel.id === 'feishu' ? '飞书' : 'Telegram'} <small>{ready ? '已连接' : '未连接或连接异常，请前往设置 → 外部连接检查'}</small>
        </label>;
      })}
    </div>
  );
}

function PreferenceHistory({ disabling, onDisable, preferences }) {
  if (preferences.length === 0) return <div className="settings-empty-state">尚未自定义通知偏好，当前使用系统默认设置。</div>;
  return (
    <div className="settings-preference-history">
      <div className="settings-block-title">保存记录</div>
      {preferences.slice(0, 8).map(preference => (
        <div className="settings-preference-row" key={preference.id}>
          <div>
            <strong>{preference.mode} · v{preference.version}</strong>
            <span>{preference.status} · 渠道：{channelText(preference)} · 更新于 {formatTime(preference.updated_at)}</span>
          </div>
          {preference.status === 'active' && !preference.admin_enforced && (
            <button className="btn btn-secondary" disabled={disabling === preference.id} onClick={() => onDisable(preference)} type="button">
              {disabling === preference.id ? '禁用中…' : '禁用'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

async function savePreference(event, form, load, setError, setSaving) {
  event.preventDefault();
  setSaving(true);
  try {
    await assistantApi.createPiGuardianPreference(buildNotificationPreferencePayload(form));
    message.success('通知偏好已保存');
    setError('');
    await load();
  } catch (error) {
    setError(error.message || '保存通知偏好失败');
  } finally {
    setSaving(false);
  }
}

async function disablePreference(preference, load, setDisabling, setError) {
  setDisabling(preference.id);
  try {
    await assistantApi.disablePiGuardianPreference(preference.id);
    message.success('通知偏好已停用，保存记录仍可查看');
    setError('');
    await load();
  } catch (error) {
    setError(error.message || '禁用通知偏好失败');
  } finally {
    setDisabling('');
  }
}

function defaultNotificationForm() {
  return { digestPolicy: {}, mode: 'normal', notifyOn: [] };
}

function formFromPreference(preference) {
  if (!preference) return defaultNotificationForm();
  return {
    digestPolicy: preference.digest_policy || {},
    mode: preference.mode || 'normal',
    notifyOn: Array.isArray(preference.notify_on) ? preference.notify_on : [],
  };
}

function channelText(preference) {
  const channels = preference.digest_policy?.channels;
  return Array.isArray(channels) && channels.length > 0 ? channels.join(', ') : '已连接的全部渠道';
}

function formatTime(value) {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
