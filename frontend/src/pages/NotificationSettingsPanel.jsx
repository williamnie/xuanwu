import { assistantApi } from '../api/assistant.js';
import { useCallback, useEffect, useState } from 'react';
import SettingsDisclosure from '../components/SettingsDisclosure.jsx';
import { BellRing, RefreshCw, Save, ShieldAlert } from 'lucide-react';
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
        : state.known ? <NotificationForm state={state} /> : null}
      {state.known && <PreferenceHistory disabling={state.disabling} onDisable={state.disable} preferences={state.preferences} />}
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
  const [known, setKnown] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await assistantApi.getPiGuardianPreferences({ scope: 'global' });
      if (!Array.isArray(data)) throw new Error('通知规则响应不完整');
      const next = data;
      setKnown(true);
      setPreferences(next);
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
    known,
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
        <h3><BellRing size={14} /> 消息通知</h3>
        <p>这里调整全局普通消息，项目和会话等更细的规则可能优先。</p>
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
          <select className="form-control" value={state.form.mode === 'verbose' ? 'normal' : state.form.mode} onChange={event => state.updateField('mode', event.target.value)}>
            <option value="normal">及时通知 · 普通消息立即发送</option>
            <option value="digest">汇总通知 · 合并普通消息</option>
            <option value="quiet">安静模式 · 普通消息静默或延后</option>
          </select>
        </label>
        {['normal','verbose'].includes(state.form.mode) && <label><input type="checkbox" checked={state.form.mode === 'verbose'} onChange={event => state.updateField('mode', event.target.checked ? 'verbose' : 'normal')} />也通知普通进展</label>}
      </div>
      <SettingsDisclosure title="更多选项"><fieldset className="settings-notify-options">
        <legend>额外立即通知</legend>
        {NOTIFY_OPTIONS.map(([token, label]) => (
          <label key={token}>
            <input checked={state.form.notifyOn.includes(token)} onChange={() => state.toggleNotifyOn(token)} type="checkbox" />
            <span>{label}<code>{token}</code></span>
          </label>
        ))}
      </fieldset></SettingsDisclosure>
      <div className="settings-notification-safety"><ShieldAlert size={15} /> <strong>重要提醒：</strong>需要你处理的事不受普通消息频率设置限制；渠道不可用或发送失败时，请检查下方外部连接。</div>
      <button className="btn btn-primary" disabled={state.saving} type="submit"><Save size={15} />{state.saving ? '保存中…' : '保存通知偏好'}</button>
    </form>
  );
}

function PreferenceHistory({ disabling, onDisable, preferences }) {
  const current = preferences.filter(preference => preference.status === 'active');
  if (current.length === 0) return <div className="settings-empty-state">尚未自定义通知偏好，当前使用系统默认设置。</div>;
  return (
    <div className="settings-preference-history">
      <div className="settings-block-title">当前规则</div>
      {current.map(preference => (
        <div className="settings-preference-row" key={preference.id}>
          <div>
            <strong>{preference.mode} · v{preference.version}</strong>
            <span>{preference.status} · 渠道：{channelText(preference)} · 更新于 {formatTime(preference.updated_at)}</span>
          </div>
          {preference.status === 'active' && !preference.admin_enforced && (
            <button className="btn btn-secondary" disabled={disabling === preference.id} onClick={() => onDisable(preference)} type="button">
              {disabling === preference.id ? '停用中…' : '恢复默认'}
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
    message.success('通知偏好已停用，恢复默认规则');
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
