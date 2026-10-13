import { assistantApi } from '../api/assistant.js';
import { connectorsApi } from '../api/connectors.js';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import { message } from '../store/toastStore';
import { PanelLoader } from '../components/TurtleLoader';
import { buildNotificationPreferencePayload, notificationModeChoice, notificationModeValue } from './settingsProductModels.js';

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
      <ActivePreference disabling={state.disabling} onDisable={state.disable} preferences={state.preferences} />
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
      <h3>通知</h3>
      <button aria-label="刷新通知设置" className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
      </button>
    </div>
  );
}

const MODE_CHOICES = [
  ['timely', '及时', '普通消息立即发送'],
  ['digest', '汇总', '合并普通消息定期发送'],
  ['quiet', '安静', '普通消息静默或延后'],
];

function NotificationForm({ state }) {
  const choice = notificationModeChoice(state.form.mode);
  const choose = (next, includeProgress = state.form.mode === 'verbose') => {
    state.updateField('mode', notificationModeValue(next, { currentMode: state.form.mode, includeProgress }));
  };
  return (
    <form className="settings-notification-form" onSubmit={state.save}>
      <div className="settings-notification-grid">
        <fieldset className="settings-notification-modes">
          <legend>通知方式</legend>
          {MODE_CHOICES.map(([id, title, hint]) => (
            <div className="settings-notification-mode" key={id}>
              <label>
                <input checked={choice === id} name="notification-mode" onChange={() => choose(id)} type="radio" />
                <span><strong>{title}</strong><small>{hint}</small></span>
              </label>
              {id === 'timely' && choice === 'timely' ? (
                <label className="settings-notification-progress">
                  <input checked={state.form.mode === 'verbose'} onChange={event => choose('timely', event.target.checked)} type="checkbox" />
                  也通知普通进展
                </label>
              ) : null}
            </div>
          ))}
          {choice === 'legacy' ? <p className="settings-notification-legacy">当前使用旧设置“{state.form.mode}”，改选后才会替换。</p> : null}
        </fieldset>
        <NotificationChannels connectors={state.connectors} />
      </div>
      <details className="settings-notify-more">
        <summary>更多选项</summary>
        <fieldset className="settings-notify-options">
          <legend>额外立即通知</legend>
          {NOTIFY_OPTIONS.map(([token, label]) => (
            <label key={token}>
              <input checked={state.form.notifyOn.includes(token)} onChange={() => state.toggleNotifyOn(token)} type="checkbox" />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </details>
      <div className="settings-notification-safety"><ShieldAlert size={15} /> 需要你处理的事不受普通消息频率设置限制；渠道不可用或发送失败时，会在外部连接里显示。这里是全局设置，项目、会话等更细的规则可能优先。</div>
      <button className="btn btn-primary" disabled={state.saving} type="submit"><Save size={15} />{state.saving ? '保存中…' : '保存'}</button>
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
          {channel.id === 'feishu' ? '飞书' : 'Telegram'} <small>{ready ? '已连接' : '未连接或连接异常，见下方外部连接'}</small>
        </label>;
      })}
    </div>
  );
}

// 只显示当前生效的自定义设置，并保留“停用（恢复默认）”；历史版本列表不再展示。
function ActivePreference({ disabling, onDisable, preferences }) {
  const active = preferences.find(item => item.status === 'active');
  if (!active) return <div className="settings-empty-state">当前使用系统默认设置。</div>;
  return (
    <div className="settings-preference-row">
      <div>
        <strong>当前使用自定义设置</strong>
        <span>渠道：{channelText(active)} · 更新于 {formatTime(active.updated_at)}{active.admin_enforced ? ' · 由管理员设置' : ''}</span>
      </div>
      {!active.admin_enforced && (
        <button className="btn btn-secondary" disabled={disabling === active.id} onClick={() => onDisable(active)} type="button">
          {disabling === active.id ? '处理中…' : '停用并恢复默认'}
        </button>
      )}
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
    message.success('已恢复默认通知设置');
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
