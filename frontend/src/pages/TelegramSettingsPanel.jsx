import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, KeyRound, MessageCircle, ScanSearch, TestTube2 } from 'lucide-react';
import { connectorsApi } from '../api/connectors.js';
import { PanelLoader } from '../components/TurtleLoader';
import { message } from '../store/toastStore';
import './FeishuSettingsPanel.css';
import './TelegramSettingsPanel.css';

const DEFAULT_FORM = {
  allowed_chat_ids: '',
  allowed_user_ids: '',
  bot_token: '',
  default_chat_id: '',
  enabled: false,
  get_me_cache_ttl_seconds: 300,
  poll_timeout_seconds: 25,
  project_mappings: '',
};

export default function TelegramSettingsPanel() {
  const state = useTelegramSettings();
  return (
    <section className="glass-card feishu-settings" id="telegram-connection-settings">
      <div className="feishu-settings__header">
        <div>
          <h2 className="feishu-settings__heading"><Bot aria-hidden="true" size={18} color="var(--primary)" /> Telegram Bot</h2>
          <p className="feishu-settings__description">通过 Bot API 长轮询接收私聊、群组与论坛 topic；allowlist 默认拒绝未授权来源。</p>
        </div>
        <span className="feishu-settings__status">
          <span className={`status-dot feishu-settings__status-dot ${state.remote?.status === 'configured' ? 'active' : 'idle'}`} />
          {state.remote?.status || 'disabled'}
        </span>
      </div>
      {state.error && <div className="feishu-settings__error" role="alert">{state.error}</div>}
      {state.loading ? <PanelLoader label="玄武正在读取 Telegram 配置…" /> : <TelegramForm state={state} />}
    </section>
  );
}

function useTelegramSettings() {
  const [error, setError] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [remote, setRemote] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const data = await connectorsApi.getTelegramSettings();
      setRemote(data);
      setForm(formFromRemote(data));
      setError('');
    } catch (loadError) {
      setRemote(null);
      setError(`加载 Telegram 配置失败：${loadError.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);
  return {
    discovering, discovery, error, form, loading, remote, saving, testing,
    chooseSource: source => chooseSource(source, { setDiscovery, setForm }),
    discover: () => discoverSource({ form, remote, setDiscovering, setDiscovery, setError, setForm }),
    save: event => save(event, { form, setError, setForm, setRemote, setSaving }),
    test: () => testConnection({ setError, setTesting }),
    update: (key, value) => setForm(current => ({ ...current, [key]: value })),
  };
}

function TelegramForm({ state }) {
  const missing = telegramMissingRequired(state.remote);
  const configuredLabel = state.remote?.enabled
    ? 'Telegram 必填凭据已配置'
    : 'Telegram 配置完整，当前未启用';
  const canDiscover = Boolean(state.form.bot_token.trim() || state.remote?.bot_token_configured);
  return (
    <form className="feishu-settings__form" onSubmit={state.save}>
      <div className="telegram-onboarding">
        <div className="telegram-onboarding__title"><KeyRound aria-hidden="true" size={15} /> 首次接入只需 Bot Token</div>
        <ol className="telegram-onboarding__steps">
          <li><span>1</span><strong>填写 Token</strong><small>粘贴 BotFather 提供的 Token</small></li>
          <li><span>2</span><strong>发送消息</strong><small>在 Telegram 给 Bot 发送 /start</small></li>
          <li><span>3</span><strong>自动识别</strong><small>玄武自动填入安全来源 ID</small></li>
        </ol>
      </div>
      <div className="telegram-onboarding__primary-fields">
        <SecretField configured={state.remote?.bot_token_configured} label="Bot Token" value={state.form.bot_token} onChange={value => state.update('bot_token', value)} />
        <label className="form-group feishu-settings__field telegram-enabled-field">
          <span>启用 Telegram</span>
          <input checked={state.form.enabled} onChange={event => state.update('enabled', event.target.checked)} type="checkbox" />
        </label>
      </div>
      <div className="telegram-discovery-toolbar">
        <div>
          <strong>自动获取 Chat ID 和 User ID</strong>
          <span>识别结果不返回消息正文，也不会因识别操作额外保存正文；只显示来源信息。</span>
        </div>
        <button className="btn btn-secondary" disabled={!canDiscover || state.discovering || state.saving} onClick={state.discover} type="button">
          <ScanSearch aria-hidden="true" size={14} />{state.discovering ? '识别中…' : '自动识别 ID'}
        </button>
      </div>
      {state.discovery ? <TelegramDiscoveryResult discovery={state.discovery} form={state.form} onChoose={state.chooseSource} /> : null}
      <details className="telegram-advanced">
        <summary>安全与高级设置 <span>自动识别后会填入，可按需调整</span></summary>
        <div className="telegram-advanced__body">
          <div className="feishu-settings__field-grid">
            <TextField label="Allowed Chat IDs" value={state.form.allowed_chat_ids} onChange={value => state.update('allowed_chat_ids', value)} placeholder="自动识别后填入" />
            <TextField label="Allowed User IDs" value={state.form.allowed_user_ids} onChange={value => state.update('allowed_user_ids', value)} placeholder="自动识别后填入" />
            <TextField label="Default Chat ID" value={state.form.default_chat_id} onChange={value => state.update('default_chat_id', value)} placeholder="自动识别后填入" />
            <NumberField label="Poll Timeout (1–50s)" max={50} min={1} value={state.form.poll_timeout_seconds} onChange={value => state.update('poll_timeout_seconds', value)} />
            <NumberField label="getMe Cache TTL (30–3600s)" max={3600} min={30} value={state.form.get_me_cache_ttl_seconds} onChange={value => state.update('get_me_cache_ttl_seconds', value)} />
          </div>
          <label className="form-group feishu-settings__field">
            <span>Project Mappings</span>
            <textarea className="form-control" rows={2} value={state.form.project_mappings} onChange={event => state.update('project_mappings', event.target.value)} placeholder="chat:-100123=xuanwu,user:123456=xuanwu" />
          </label>
          <div className="feishu-settings__hint-copy">Bot API 使用 long polling，无需公网回调地址。群内首次识别请发送 mention、command 或回复 Bot；BotFather privacy mode 仍决定 Telegram 是否投递普通群消息。配置文件：<code>{state.remote?.settings_file || 'runner-settings.local.json'}</code></div>
        </div>
      </details>
      <div className="telegram-source-summary" aria-live="polite">
        <MessageCircle aria-hidden="true" size={14} />
        {state.form.allowed_chat_ids && state.form.allowed_user_ids
          ? '安全来源已填写，保存后只有这些 Chat 与 User 可以触发玄武。'
          : '尚未识别安全来源，请先给 Bot 发消息再点击“自动识别 ID”。'}
      </div>
      <div className="feishu-settings__footer">
        <div className={`feishu-settings__footer-status${missing.length ? ' is-warning' : ''}`}>
          {missing.length ? `缺少：${missing.join(', ')}` : <><CheckCircle2 aria-hidden="true" size={14} /> {configuredLabel}</>}
        </div>
        <div className="connector-diagnostics__actions">
          <button className="btn btn-secondary" disabled={state.remote?.status !== 'configured' || state.testing || state.saving} onClick={state.test} type="button"><TestTube2 aria-hidden="true" size={14} />{state.testing ? '测试中…' : '测试连接'}</button>
          <button className="btn btn-primary" disabled={!state.remote || state.saving} type="submit">{state.saving ? '保存中…' : '保存 Telegram Bot'}</button>
        </div>
      </div>
    </form>
  );
}

function TelegramDiscoveryResult({ discovery, form, onChoose }) {
  const username = discovery.bot?.username || '';
  const sources = discovery.sources || [];
  return (
    <div className="telegram-discovery" aria-live="polite">
      <div className="telegram-discovery__bot">
        <CheckCircle2 aria-hidden="true" size={14} />
        <span>Bot 已连接{username ? <>：<a href={`https://t.me/${username}`} rel="noreferrer" target="_blank">@{username}</a></> : ''}</span>
      </div>
      {sources.length === 0 ? (
        <p>还没检测到消息。请先在 Telegram 给这个 Bot 发送 <code>/start</code>，然后再次点击“自动识别 ID”。</p>
      ) : (
        <div className="telegram-discovery__sources">
          <span className="telegram-discovery__label">选择允许操作玄武的来源</span>
          {sources.map(source => {
            const selected = source.chat_id === form.default_chat_id && commaValues(form.allowed_user_ids).includes(source.user_id);
            return (
              <button className={`telegram-source${selected ? ' is-selected' : ''}`} key={`${source.chat_id}:${source.user_id}`} onClick={() => onChoose(source)} type="button">
                <span><strong>{source.chat_title || source.user_display_name || source.user_username || 'Telegram 来源'}</strong><small>{sourceKind(source.chat_type)} · Chat {source.chat_id} · User {source.user_id}</small></span>
                <span>{selected ? '已选择' : '使用'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function telegramMissingRequired(remote) {
  if (!remote) return ['配置未加载'];
  return [
    !remote.bot_token_configured ? 'Bot Token' : '',
    !(remote.allowed_chat_ids || []).length ? '安全来源 Chat ID' : '',
    !(remote.allowed_user_ids || []).length ? '安全来源 User ID' : '',
  ].filter(Boolean);
}

function TextField({ label, onChange, placeholder, value }) {
  return <label className="form-group feishu-settings__field"><span>{label}</span><input className="form-control" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function NumberField({ label, max, min, onChange, value }) {
  return <label className="form-group feishu-settings__field"><span>{label}</span><input className="form-control" max={max} min={min} type="number" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}

function SecretField({ configured, label, onChange, value }) {
  return <label className="form-group feishu-settings__field"><span>{label}</span><input className="form-control" type="password" value={value} onChange={event => onChange(event.target.value)} placeholder={configured ? '已配置，留空不覆盖' : '未配置'} /></label>;
}

async function discoverSource(state) {
  if (!state.form.bot_token.trim() && !state.remote?.bot_token_configured) {
    state.setError('请先填写 Bot Token');
    return;
  }
  state.setDiscovering(true);
  state.setError('');
  try {
    const result = await connectorsApi.discoverTelegramSource(state.form.bot_token.trim());
    const sources = result.sources || [];
    state.setDiscovery(result);
    if (sources.length === 1) {
      const source = sources[0];
      state.setForm(current => formWithSource(current, source));
      state.setDiscovery(current => ({ ...current, selected_key: `${source.chat_id}:${source.user_id}` }));
      message.success('已自动识别并填入 Telegram 安全来源');
    } else if (sources.length === 0) {
      message.info('Bot 已连接；发送 /start 后再识别一次');
    } else {
      message.info('检测到多个来源，请选择要授权的私聊或群聊');
    }
  } catch (error) {
    state.setError(error.message || 'Telegram 来源识别失败');
  } finally {
    state.setDiscovering(false);
  }
}

function chooseSource(source, state) {
  state.setForm(current => formWithSource(current, source));
  state.setDiscovery(current => current ? ({ ...current, selected_key: `${source.chat_id}:${source.user_id}` }) : current);
  message.success('已填入选中的 Telegram 安全来源');
}

function formWithSource(form, source) {
  return {
    ...form,
    allowed_chat_ids: mergeCommaValue(form.allowed_chat_ids, source.chat_id),
    allowed_user_ids: mergeCommaValue(form.allowed_user_ids, source.user_id),
    default_chat_id: source.chat_id,
    enabled: true,
  };
}

function mergeCommaValue(current, value) {
  return [...new Set([...commaValues(current), value].filter(Boolean))].join(', ');
}

function commaValues(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function sourceKind(value) {
  if (value === 'private' || value === 'direct') return '私聊';
  if (value === 'group' || value === 'supergroup') return '群聊';
  if (value === 'channel') return '频道';
  return '未知类型';
}

async function save(event, state) {
  event.preventDefault();
  state.setSaving(true);
  state.setError('');
  try {
    const data = await connectorsApi.updateTelegramSettings(state.form);
    state.setRemote(data);
    state.setForm(formFromRemote(data));
    message.success('Telegram Bot 配置已保存');
  } catch (error) {
    state.setError(error.message || '保存 Telegram 配置失败');
  } finally {
    state.setSaving(false);
  }
}

async function testConnection(state) {
  state.setTesting(true);
  state.setError('');
  try {
    const result = await connectorsApi.testTelegramConnection();
    if (!result.ok) throw new Error('Bot 已配置 webhook，暂不能启动 long polling');
    message.success(`Telegram 连接正常${result.bot?.username ? `：@${result.bot.username}` : ''}`);
  } catch (error) {
    state.setError(error.message || 'Telegram 连接测试失败');
  } finally {
    state.setTesting(false);
  }
}

function formFromRemote(data) {
  return {
    ...DEFAULT_FORM,
    allowed_chat_ids: (data?.allowed_chat_ids || []).join(', '),
    allowed_user_ids: (data?.allowed_user_ids || []).join(', '),
    default_chat_id: data?.default_chat_id || '',
    enabled: Boolean(data?.enabled),
    get_me_cache_ttl_seconds: data?.get_me_cache_ttl_seconds || 300,
    poll_timeout_seconds: data?.poll_timeout_seconds || 25,
    project_mappings: data?.project_mappings || '',
  };
}
