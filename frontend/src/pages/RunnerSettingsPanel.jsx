import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, Monitor, RefreshCw, Rocket, Save, Terminal } from 'lucide-react';
import { message } from '../store/toastStore';
import './RunnerSettingsPanel.css';

const DEFAULT_SETTINGS = {
  codex_app_command: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
  codex_app_status: null,
  codex_cli_command: 'codex app-server --listen stdio://',
  codex_cli_status: null,
  codex_effective_command: 'codex app-server --listen stdio://',
  codex_server_mode: 'cli',
  codex_server_modes: ['cli', 'app'],
  max_parallel_projects: 1,
  min_parallel_projects: 1,
  max_parallel_projects_limit: 8,
  settings_file: '',
};

export default function RunnerSettingsPanel() {
  const state = useRunnerSettings();
  return (
    <section className="glass-card runner-settings">
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.error && <div className="runner-settings__error">{state.error}</div>}
      <FirstUseLauncher settings={state.settings} />
      <SettingsForm {...state} />
    </section>
  );
}

function useRunnerSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState(draftFromSettings(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSettings = () => {
    setLoading(true);
    systemApi.getRunnerSettings()
      .then((data) => {
        const normalized = normalizeSettings(data);
        setSettings(normalized);
        setDraft(draftFromSettings(normalized));
        setError('');
      })
      .catch((err) => setError(err.message || '读取 Runner 设置失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await systemApi.updateRunnerSettings(settingsPayload(draft));
      const normalized = normalizeSettings(updated);
      setSettings(normalized);
      setDraft(draftFromSettings(normalized));
      setError('');
      showSaveResult(updated);
    } catch (err) {
      setError(err.message || '保存 Runner 设置失败');
    } finally {
      setSaving(false);
    }
  };

  return { draft, error, handleSubmit, loading, loadSettings, saving, setDraft, settings };
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="runner-settings__header">
      <div>
        <h2 className="runner-settings__heading">
          <Gauge size={18} color="var(--primary)" /> Runner Execution
        </h2>
        <p className="runner-settings__description">
          显式选择 Runner 接入 Codex CLI 还是 Codex App；选择后只影响新的 issue/session。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        刷新
      </button>
    </div>
  );
}

function FirstUseLauncher({ settings }) {
  const installCommand = 'curl -fsSL https://raw.githubusercontent.com/williamnie/xuanwu/main/scripts/install-release.sh | bash';
  const projectCommand = 'xuanwu project create --id my-project --cwd /path/to/project --auto-run';
  return (
    <div className="runner-settings__launcher">
      <div className="runner-settings__strong-row">
        <Rocket size={17} color="var(--primary)" /> 首次使用启动器
      </div>
      <div className="runner-settings__launcher-grid">
        <LauncherStep title="1. 安装后台服务" body="Release 安装脚本会下载二进制并注册 launchd/systemd。" code={installCommand} />
        <LauncherStep title="2. 准备 Codex" body="确认 codex CLI 可用，或安装/打开 Codex App 并完成登录。" code="codex login && codex app" />
        <LauncherStep title="3. 选择 server" body={`当前使用 ${settings.codex_server_mode === 'app' ? 'Codex App' : 'Codex CLI'}，保存后不自动 fallback。`} code={settings.codex_effective_command} />
        <LauncherStep title="4. 创建项目" body="把本地仓库注册进 runner，之后可从 Dashboard 创建 issue。" code={projectCommand} />
      </div>
    </div>
  );
}

function LauncherStep({ title, body, code }) {
  return (
    <div className="runner-settings__launcher-step">
      <div className="runner-settings__strong">{title}</div>
      <div className="runner-settings__muted-copy">{body}</div>
      <code className="runner-settings__command">{code}</code>
    </div>
  );
}

function SettingsForm({ draft, handleSubmit, loading, saving, setDraft, settings }) {
  const max = settings.max_parallel_projects_limit || DEFAULT_SETTINGS.max_parallel_projects_limit;
  const min = settings.min_parallel_projects || DEFAULT_SETTINGS.min_parallel_projects;
  return (
    <form className="runner-settings__form" onSubmit={handleSubmit}>
      <CodexServerSelector draft={draft} disabled={loading || saving} setDraft={setDraft} settings={settings} />
      <label className="runner-settings__field">
        <span className="runner-settings__label">全局项目并发数</span>
        <input
          className="form-control"
          type="number"
          min={min}
          max={max}
          step="1"
          value={draft.maxParallelProjects}
          disabled={loading || saving}
          onChange={(event) => updateDraft(setDraft, { maxParallelProjects: event.target.value })}
        />
      </label>
      <div className="runner-settings__help">
        可填 {min}-{max}。Runner 会按项目工作区串行 claim issue，不同项目在该上限内并行启动。
        {settings.settings_file && <div>配置文件：<code>{settings.settings_file}</code></div>}
      </div>
      <div>
        <button className="btn btn-primary" type="submit" disabled={loading || saving}>
          <Save size={15} />
          {saving ? '保存中...' : '保存 Runner 设置'}
        </button>
      </div>
    </form>
  );
}

function CodexServerSelector({ draft, disabled, setDraft, settings }) {
  return (
    <div className="runner-settings__selector">
      <span className="runner-settings__label">Codex server 接入方式</span>
      <div className="runner-settings__server-grid">
        <ServerOption id="cli" icon={<Terminal size={16} />} draft={draft} disabled={disabled} setDraft={setDraft} title="Codex CLI" description="独立拉起 CLI app-server，适合稳定后台自动执行。" />
        <ServerOption id="app" icon={<Monitor size={16} />} draft={draft} disabled={disabled} setDraft={setDraft} title="Codex App" description="使用 Codex App bundled server 环境，适合需要 App/Chrome 集成的任务。" />
      </div>
      <CommandInput label="CLI server command" value={draft.codexCliCommand} disabled={disabled} onChange={(value) => updateDraft(setDraft, { codexCliCommand: value })} />
      <CommandInput label="App server command" value={draft.codexAppCommand} disabled={disabled} onChange={(value) => updateDraft(setDraft, { codexAppCommand: value })} />
      <CommandStatus title="Codex CLI 检测" status={settings.codex_cli_status} />
      <AppStatus status={settings.codex_app_status} selected={draft.codexServerMode === 'app'} />
    </div>
  );
}

function ServerOption({ description, disabled, draft, icon, id, setDraft, title }) {
  const active = draft.codexServerMode === id;
  return (
    <button
      className={`btn btn-secondary runner-settings__server-option${active ? ' is-active' : ''}`}
      type="button"
      disabled={disabled}
      onClick={() => updateDraft(setDraft, { codexServerMode: id })}
    >
      <span className="runner-settings__server-option-copy">
        <span className="runner-settings__strong-row">{icon}{title}</span>
        <span className="runner-settings__option-description">{description}</span>
      </span>
    </button>
  );
}

function CommandInput({ disabled, label, onChange, value }) {
  return (
    <label className="runner-settings__field">
      <span className="runner-settings__field-label">{label}</span>
      <input className="form-control" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function AppStatus({ selected, status }) {
  if (!status) return null;
  const ok = status.installed && (!selected || status.native_host_configured);
  return (
    <div className={`runner-settings__status ${ok ? 'is-success' : 'is-warning'}`}>
      <div className="runner-settings__strong-row">
        {ok ? <CheckCircle2 size={15} color="var(--success)" /> : <AlertTriangle size={15} color="var(--warning)" />}
        Codex App 检测：{status.installed ? '已安装' : '未找到'} / {status.running ? '正在运行' : '未检测到运行态'}
      </div>
      <div className="runner-settings__status-detail">
        App command: <code>{status.command || '未检测到'}</code>
      </div>
      {selected && !status.running && (
        <div className="runner-settings__warning">已选择 App 时不会自动 fallback；如果你关闭 Codex App 或 App 集成不可用，新任务会按当前配置失败。</div>
      )}
    </div>
  );
}

function CommandStatus({ status, title }) {
  if (!status) return null;
  return (
    <div className="runner-settings__status">
      <div className="runner-settings__strong-row">
        <span className={`status-dot runner-settings__status-dot ${status.available ? 'active' : 'idle'}`}></span>
        {title}：{status.available ? 'available' : 'missing'}
      </div>
      <div className="runner-settings__status-detail">
        {status.path || status.error || status.command}
        {status.version && <span> · {status.version}</span>}
      </div>
    </div>
  );
}

function normalizeSettings(value) {
  return {
    codex_app_command: value?.codex_app_command || DEFAULT_SETTINGS.codex_app_command,
    codex_app_status: value?.codex_app_status || null,
    codex_cli_command: value?.codex_cli_command || DEFAULT_SETTINGS.codex_cli_command,
    codex_cli_status: value?.codex_cli_status || null,
    codex_effective_command: value?.codex_effective_command || DEFAULT_SETTINGS.codex_effective_command,
    codex_server_mode: value?.codex_server_mode === 'app' ? 'app' : 'cli',
    codex_server_modes: value?.codex_server_modes || DEFAULT_SETTINGS.codex_server_modes,
    max_parallel_projects: value?.max_parallel_projects || DEFAULT_SETTINGS.max_parallel_projects,
    min_parallel_projects: value?.min_parallel_projects || DEFAULT_SETTINGS.min_parallel_projects,
    max_parallel_projects_limit: value?.max_parallel_projects_limit || DEFAULT_SETTINGS.max_parallel_projects_limit,
    settings_file: value?.settings_file || '',
  };
}

function draftFromSettings(settings) {
  return {
    codexAppCommand: settings.codex_app_command,
    codexCliCommand: settings.codex_cli_command,
    codexServerMode: settings.codex_server_mode,
    maxParallelProjects: String(settings.max_parallel_projects),
  };
}

function settingsPayload(draft) {
  return {
    codex_app_command: draft.codexAppCommand,
    codex_cli_command: draft.codexCliCommand,
    codex_server_mode: draft.codexServerMode,
    max_parallel_projects: Number(draft.maxParallelProjects),
  };
}

function updateDraft(setDraft, patch) {
  setDraft((current) => ({ ...current, ...patch }));
}

function showSaveResult(updated) {
  const apply = updated?.runtime_apply?.codexTransport;
  if (apply === 'deferred_active_sessions') {
    message.warning('已保存；当前有运行中的 Codex session，未重启 transport，结束后请再保存一次或重启服务');
    return;
  }
  message.success('Runner 设置已保存');
}
