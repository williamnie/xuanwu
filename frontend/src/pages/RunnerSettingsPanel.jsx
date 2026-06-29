import { useEffect, useState } from 'react';
import { Gauge, RefreshCw, Save } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

const DEFAULT_SETTINGS = {
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
      <SettingsForm {...state} />
    </section>
  );
}

function useRunnerSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState(String(DEFAULT_SETTINGS.max_parallel_projects));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSettings = () => {
    setLoading(true);
    api.getRunnerSettings()
      .then((data) => {
        setSettings(normalizeSettings(data));
        setDraft(String(data.max_parallel_projects || DEFAULT_SETTINGS.max_parallel_projects));
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
      const updated = await api.updateRunnerSettings({ max_parallel_projects: Number(draft) });
      const normalized = normalizeSettings(updated);
      setSettings(normalized);
      setDraft(String(normalized.max_parallel_projects));
      setError('');
      message.success('Runner 并发设置已保存');
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
          控制全局可并行执行的项目数；同一项目仍保持串行。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        刷新
      </button>
    </div>
  );
}

function SettingsForm({ draft, handleSubmit, loading, saving, setDraft, settings }) {
  const max = settings.max_parallel_projects_limit || DEFAULT_SETTINGS.max_parallel_projects_limit;
  const min = settings.min_parallel_projects || DEFAULT_SETTINGS.min_parallel_projects;
  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '12px' }}>
      <label style={{ display: 'grid', gap: '6px' }}>
        <span style={{ fontWeight: 700 }}>全局项目并发数</span>
        <input
          className="form-control"
          type="number"
          min={min}
          max={max}
          step="1"
          value={draft}
          disabled={loading || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.6 }}>
        可填 {min}-{max}。Runner 会按项目工作区串行 claim issue，不同项目在该上限内并行启动。
        {settings.settings_file && <div>配置文件：<code>{settings.settings_file}</code></div>}
      </div>
      <div>
        <button className="btn btn-primary" type="submit" disabled={loading || saving}>
          <Save size={15} />
          {saving ? '保存中...' : '保存并发设置'}
        </button>
      </div>
    </form>
  );
}

function normalizeSettings(value) {
  return {
    max_parallel_projects: value?.max_parallel_projects || DEFAULT_SETTINGS.max_parallel_projects,
    min_parallel_projects: value?.min_parallel_projects || DEFAULT_SETTINGS.min_parallel_projects,
    max_parallel_projects_limit: value?.max_parallel_projects_limit || DEFAULT_SETTINGS.max_parallel_projects_limit,
    settings_file: value?.settings_file || '',
  };
}
