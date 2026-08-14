import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, Monitor, RefreshCw, Rocket, Save, Terminal } from 'lucide-react';
import { message } from '../store/toastStore';

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
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={state.loadSettings} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
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
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Gauge size={18} color="var(--primary)" /> Runner Execution
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
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
    <div style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-xl)', padding: '14px', background: 'var(--bg-secondary)', display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800 }}>
        <Rocket size={17} color="var(--primary)" /> 首次使用启动器
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px' }}>
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
    <div style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)', padding: '12px', display: 'grid', gap: '8px' }}>
      <div style={{ fontWeight: 800 }}>{title}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.5 }}>{body}</div>
      <code style={{ fontSize: '0.72rem', wordBreak: 'break-word', color: 'var(--text-secondary)' }}>{code}</code>
    </div>
  );
}

function SettingsForm({ draft, handleSubmit, loading, saving, setDraft, settings }) {
  const max = settings.max_parallel_projects_limit || DEFAULT_SETTINGS.max_parallel_projects_limit;
  const min = settings.min_parallel_projects || DEFAULT_SETTINGS.min_parallel_projects;
  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '14px' }}>
      <CodexServerSelector draft={draft} disabled={loading || saving} setDraft={setDraft} settings={settings} />
      <label style={{ display: 'grid', gap: '6px' }}>
        <span style={{ fontWeight: 700 }}>全局项目并发数</span>
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
      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.6 }}>
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
    <div style={{ display: 'grid', gap: '10px' }}>
      <span style={{ fontWeight: 700 }}>Codex server 接入方式</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
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
      className="btn btn-secondary"
      type="button"
      disabled={disabled}
      onClick={() => updateDraft(setDraft, { codexServerMode: id })}
      style={{ justifyContent: 'flex-start', borderColor: active ? 'var(--primary)' : 'var(--border-light)', background: active ? 'var(--primary-glow)' : 'var(--bg-secondary)', height: 'auto', padding: '12px' }}
    >
      <span style={{ display: 'grid', gap: '5px', textAlign: 'left' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800 }}>{icon}{title}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem', lineHeight: 1.45 }}>{description}</span>
      </span>
    </button>
  );
}

function CommandInput({ disabled, label, onChange, value }) {
  return (
    <label style={{ display: 'grid', gap: '6px' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem', fontWeight: 700 }}>{label}</span>
      <input className="form-control" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function AppStatus({ selected, status }) {
  if (!status) return null;
  const ok = status.installed && (!selected || status.native_host_configured);
  return (
    <div style={{ border: `1px solid ${ok ? 'var(--success)' : 'var(--warning)'}`, borderRadius: 'var(--radius-lg)', padding: '10px', background: ok ? 'var(--success-glow)' : 'var(--warning-bg)', fontSize: '0.8rem', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800 }}>
        {ok ? <CheckCircle2 size={15} color="var(--success)" /> : <AlertTriangle size={15} color="var(--warning)" />}
        Codex App 检测：{status.installed ? '已安装' : '未找到'} / {status.running ? '正在运行' : '未检测到运行态'}
      </div>
      <div style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}>
        App command: <code>{status.command || '未检测到'}</code>
      </div>
      {selected && !status.running && (
        <div style={{ color: 'var(--warning)' }}>已选择 App 时不会自动 fallback；如果你关闭 Codex App 或 App 集成不可用，新任务会按当前配置失败。</div>
      )}
    </div>
  );
}

function CommandStatus({ status, title }) {
  if (!status) return null;
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius-lg)', padding: '10px', background: 'var(--bg-secondary)', fontSize: '0.8rem', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800 }}>
        <span className={`status-dot ${status.available ? 'active' : 'idle'}`} style={{ width: '7px', height: '7px' }}></span>
        {title}：{status.available ? 'available' : 'missing'}
      </div>
      <div style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}>
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
