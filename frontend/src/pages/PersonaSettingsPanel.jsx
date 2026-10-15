import { useCallback, useEffect, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import { assistantApi } from '../api/assistant.js';
import { PanelLoader } from '../components/TurtleLoader';
import { message } from '../store/toastStore';
import { personaDirty, personaFormFromSupervisor, personaPatchPayload } from './personaSettingsModel.js';
import './PiAgentSettingsPanel.css';

// 对话与通知的表达风格：本分区是 persona 唯一的表单所有者，单独读取、单独保存。
export default function PersonaSettingsPanel() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [conflictDraft, setConflictDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = personaFormFromSupervisor(await assistantApi.getPiSupervisor());
      setSaved(next);
      setForm(next);
      setError('');
      return next;
    } catch (loadError) {
      setError(loadError.message || '读取表达风格失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const dirty = form && saved ? personaDirty(form, saved) : false;

  const save = async (event) => {
    event.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    try {
      await assistantApi.updatePiSupervisor(personaPatchPayload(form));
      setConflictDraft(null);
      message.success('表达风格已保存');
      await load();
    } catch (saveError) {
      if (saveError?.status === 409) {
        const draft = form;
        await load();
        setConflictDraft(draft);
        message.error('表达风格已被其他修改更新；已加载最新版本，并保留你的草稿供比较');
      } else {
        message.error(saveError.message || '保存表达风格失败');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading && !form) return <PanelLoader label="正在读取表达风格…" />;
  if (!form) return <div className="settings-inline-error" role="alert">{error || '表达风格暂不可用'}</div>;

  return (
    <form className="persona-settings-panel" onSubmit={save}>
      <header className="settings-product-header">
        <h3><Sparkles size={15} /> 对话与通知的表达风格</h3>
      </header>
      <p className="persona-boundary-notice">只影响对话回复和通知的措辞，不改变通知是否发送，也不改变权限、审批、工具调用、任务状态和完成判定。</p>
      {conflictDraft ? (
        <div className="persona-conflict-notice" role="status">
          <strong>配置已被更新</strong>
          <span>表单已显示最新配置；你的草稿保留在下面，比较后可以恢复继续编辑。</span>
          <details><summary>查看本地草稿</summary><pre>{JSON.stringify({ enabled: conflictDraft.enabled, personality: conflictDraft.personality, communication_style: conflictDraft.communicationStyle, verbosity: conflictDraft.verbosity, language_mode: conflictDraft.languageMode }, null, 2)}</pre></details>
          <div>
            <button className="btn btn-secondary" onClick={() => { setForm({ ...conflictDraft, revision: saved.revision }); setConflictDraft(null); }} type="button">恢复本地草稿</button>
            <button className="btn btn-secondary" onClick={() => setConflictDraft(null)} type="button">使用最新版本</button>
          </div>
        </div>
      ) : null}
      <label className="persona-enable-field"><input checked={form.enabled} onChange={event => update('enabled', event.target.checked)} type="checkbox" />启用自定义表达风格（默认关闭）</label>
      <div className="persona-select-grid">
        <label className="form-group supervisor-form-field">
          <span className="supervisor-field-label"><span>回复长度</span></span>
          <select className="form-control" onChange={event => update('verbosity', event.target.value)} value={form.verbosity}>
            <option value="adaptive">自适应</option><option value="concise">简短</option><option value="detailed">详细</option>
          </select>
        </label>
        <label className="form-group supervisor-form-field">
          <span className="supervisor-field-label"><span>语言</span></span>
          <select className="form-control" onChange={event => update('languageMode', event.target.value)} value={form.languageMode}>
            <option value="system">跟随系统</option><option value="follow_user">跟随当前用户消息</option>
          </select>
        </label>
      </div>
      <details className="persona-settings-disclosure">
        <summary><span><strong>更多选项</strong><small>性格描述与沟通风格</small></span></summary>
        <div className="persona-settings-content">
          <label className="form-group supervisor-form-field">
            <span className="supervisor-field-label"><span>性格描述 · {form.personality.length}/1000</span></span>
            <textarea className="form-control" maxLength={1000} onChange={event => update('personality', event.target.value)} rows={3} value={form.personality} />
          </label>
          <label className="form-group supervisor-form-field">
            <span className="supervisor-field-label"><span>沟通风格 · {form.communicationStyle.length}/2000</span></span>
            <textarea className="form-control" maxLength={2000} onChange={event => update('communicationStyle', event.target.value)} rows={4} value={form.communicationStyle} />
          </label>
        </div>
      </details>
      <div className="persona-save-row">
        <span>{dirty ? '有未保存的修改' : '已保存'}</span>
        <button className="btn btn-secondary" disabled={saving || !dirty} type="submit"><Save size={14} />{saving ? '保存中…' : '保存表达风格'}</button>
      </div>
    </form>
  );
}
