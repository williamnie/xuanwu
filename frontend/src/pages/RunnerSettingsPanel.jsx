import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { message } from '../store/toastStore';
import './RunnerSettingsPanel.css';

export default function RunnerSettingsPanel() {
  const [state, setState] = useState({ settings: null, draft: '1', loading: true, saving: false, error: '' });
  const loadSettings = () => {
    setState(current => ({ ...current, loading: true }));
    systemApi.getRunnerSettings().then(settings => setState({ settings, draft: String(settings.max_parallel_projects || 1), loading: false, saving: false, error: '' }))
      .catch(error => setState(current => ({ ...current, loading: false, error: error.message })));
  };
  useEffect(() => { loadSettings(); }, []);
  const save = async event => {
    event.preventDefault();
    setState(current => ({ ...current, saving: true, error: '' }));
    try {
      // 只保存本区域字段，不把旧的 Codex 配置往返覆盖。
      const settings = await systemApi.updateRunnerSettings({ max_parallel_projects: Number(state.draft) });
      setState(current => ({ ...current, settings, saving: false }));
      message.success('并发设置已保存');
    } catch (error) { setState(current => ({ ...current, saving: false, error: error.message })); }
  };
  return <section className="glass-card runner-settings">
    <button className="btn btn-secondary" onClick={loadSettings} disabled={state.loading || state.saving} type="button"><RefreshCw size={14} />刷新</button>
    {state.error && <div className="runner-settings__error" role="alert">{state.error}</div>}
    <form className="runner-settings__form" onSubmit={save}>
      <label className="runner-settings__field"><span>全局项目并发数</span>
        <input className="form-control" type="number" min={state.settings?.min_parallel_projects || 1} max={state.settings?.max_parallel_projects_limit || 8} step="1" value={state.draft} disabled={state.loading || state.saving} onChange={event => setState(current => ({ ...current, draft: event.target.value }))} />
      </label>
      <p className="runner-settings__help">限制同时执行的项目数，同一工作区中的任务依次执行。</p>
      <button className="btn btn-secondary" disabled={state.loading || state.saving} type="submit"><Save size={14} />{state.saving ? '保存中…' : '保存并发设置'}</button>
    </form>
  </section>;
}
