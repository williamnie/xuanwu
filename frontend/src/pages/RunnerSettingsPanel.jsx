import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { message } from '../store/toastStore';
import './RunnerSettingsPanel.css';

const DEFAULT_LIMITS = { max: 8, min: 1 };

// 全局并发数。Codex 运行方式与命令只在 AI 连接 → Codex 一处配置（方案 6.4 ②），
// 这里只提交 max_parallel_projects，后端按字段合并，不会改动 Codex 配置。
export default function RunnerSettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState('1');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    systemApi.getRunnerSettings()
      .then((data) => {
        if (!alive) return;
        setSettings(data);
        setDraft(String(data?.max_parallel_projects || 1));
        setError('');
      })
      .catch((err) => { if (alive) setError(err.message || '读取并发设置失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const min = settings?.min_parallel_projects || DEFAULT_LIMITS.min;
  const max = settings?.max_parallel_projects_limit || DEFAULT_LIMITS.max;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await systemApi.updateRunnerSettings({ max_parallel_projects: Number(draft) });
      setSettings(updated);
      setDraft(String(updated?.max_parallel_projects || draft));
      setError('');
      message.success('并发设置已保存');
    } catch (err) {
      setError(err.message || '保存并发设置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="runner-settings runner-settings__form" onSubmit={handleSubmit}>
      {error && <div className="runner-settings__error">{error}</div>}
      <label className="runner-settings__field">
        <span className="runner-settings__label">同时执行的项目数</span>
        <input
          className="form-control"
          disabled={loading || saving}
          max={max}
          min={min}
          onChange={(event) => setDraft(event.target.value)}
          step="1"
          type="number"
          value={draft}
        />
      </label>
      <div className="runner-settings__help">
        可填 {min}–{max}。同一个项目内的任务依次执行，不同项目在这个上限内同时执行。
        {settings?.settings_file && <div>配置文件：<code>{settings.settings_file}</code></div>}
      </div>
      <div>
        <button className="btn btn-secondary" disabled={loading || saving} type="submit">
          <Save size={15} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
