import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Pause, Play, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import {
  selectCronTasks,
  selectProjects,
  selectRefreshAllData,
  useDataStore,
} from '../store/dataStore';

const CRON_ACTION_TRIAGE_TO_TODO = 'triage_to_todo';

function defaultRunAt() {
  const date = new Date();
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return toLocalInputValue(date);
}

function toLocalInputValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function modeLabel(mode) {
  return mode === 'daily' ? '每天重复' : '仅运行一次';
}

function statusLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'paused') return 'Paused';
  if (status === 'done') return 'Done';
  return status || 'Unknown';
}

export default function CronTasksPanel({ compact = false, defaultProjectId = '' }) {
  const projects = useDataStore(selectProjects);
  const cronTasks = useDataStore(selectCronTasks);
  const refreshAllData = useDataStore(selectRefreshAllData);
  const [open, setOpen] = useState(!compact);
  const [form, setForm] = useState({
    projectId: defaultProjectId,
    mode: 'once',
    runAt: defaultRunAt(),
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const visibleTasks = useMemo(() => {
    if (!defaultProjectId) return cronTasks;
    return cronTasks.filter(task => !task.project_id || task.project_id === defaultProjectId);
  }, [cronTasks, defaultProjectId]);

  useEffect(() => {
    if (compact && !open) {
      setForm(prev => ({ ...prev, projectId: defaultProjectId }));
    }
  }, [compact, defaultProjectId, open]);

  const updateField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.createCronTask(buildPayload(form, projects));
      await refreshAllData();
      setForm(prev => ({ ...prev, runAt: defaultRunAt() }));
      if (compact) setOpen(false);
    } catch (err) {
      setError(err.message || '创建 cron 任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (task) => {
    const status = task.status === 'active' ? 'paused' : 'active';
    try {
      await api.updateCronTask(task.id, { status });
      refreshAllData();
    } catch (err) {
      alert(err.message || '更新 cron 任务失败');
    }
  };

  const handleDelete = async (task) => {
    if (!window.confirm(`删除定时任务「${task.name}」？`)) return;
    try {
      await api.deleteCronTask(task.id);
      refreshAllData();
    } catch (err) {
      alert(err.message || '删除 cron 任务失败');
    }
  };

  if (compact) {
    return (
      <>
        <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '0.78rem' }} onClick={() => setOpen(true)}>
          <CalendarClock size={14} /> 定时运行 Triage
        </button>
        {open && (
          <div className="modal-overlay">
            <div className="glass-card modal-content" style={{ maxWidth: '680px', padding: '22px' }}>
              <PanelHeader onClose={() => setOpen(false)} />
              {renderForm({ projects, form, updateField, error, submitting, handleSubmit })}
              {renderTaskList({ tasks: visibleTasks, projects, handleToggleStatus, handleDelete })}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <PanelHeader />
      {renderForm({ projects, form, updateField, error, submitting, handleSubmit })}
      {renderTaskList({ tasks: visibleTasks, projects, handleToggleStatus, handleDelete })}
    </section>
  );
}

function PanelHeader({ onClose }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
      <div>
        <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <CalendarClock size={17} color="var(--primary)" /> Triage Cron
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '4px' }}>
          到点后将匹配范围内的 Triage issue 批量切到 Todo，并启动对应项目运行。
        </p>
      </div>
      {onClose && (
        <button className="btn btn-secondary" style={{ padding: '6px' }} onClick={onClose}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function renderForm({ projects, form, updateField, error, submitting, handleSubmit }) {
  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr auto', gap: '12px', alignItems: 'end' }}>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>运行范围</label>
        <select className="form-control" value={form.projectId} onChange={(e) => updateField('projectId', e.target.value)}>
          <option value="">所有项目的 Triage</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>模式</label>
        <select className="form-control" value={form.mode} onChange={(e) => updateField('mode', e.target.value)}>
          <option value="once">仅运行一次</option>
          <option value="daily">每天重复</option>
        </select>
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label>{form.mode === 'daily' ? '每日时间' : '开始时间'}</label>
        <input className="form-control" type="datetime-local" value={form.runAt} onChange={(e) => updateField('runAt', e.target.value)} required />
      </div>
      <button className="btn btn-primary" style={{ padding: '8px 14px' }} disabled={submitting}>
        {submitting ? '保存中...' : '设置 Cron'}
      </button>
      {error && (
        <div style={{ gridColumn: '1 / -1', color: 'var(--error)', fontSize: '0.78rem' }}>{error}</div>
      )}
    </form>
  );
}

function renderTaskList({ tasks, projects, handleToggleStatus, handleDelete }) {
  if (tasks.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>暂无定时任务。</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {tasks.map(task => (
        <div key={task.id} className="glass-card" style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{task.name}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>
              {projectLabel(projects, task.project_id)} · {modeLabel(task.mode)} · 下次：{formatDateTime(task.next_run_at)} · 已运行 {task.run_count} 次
            </div>
            {task.error && <div style={{ color: 'var(--error)', fontSize: '0.74rem', marginTop: '4px' }}>{task.error}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={`status-badge ${task.status === 'active' ? 'todo' : 'cancelled'}`}>{statusLabel(task.status)}</span>
            {task.status !== 'done' && (
              <button className="btn btn-secondary" style={{ padding: '6px' }} onClick={() => handleToggleStatus(task)}>
                {task.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
              </button>
            )}
            <button className="btn btn-secondary" style={{ padding: '6px', color: 'var(--error)' }} onClick={() => handleDelete(task)}>
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function buildPayload(form, projects) {
  const runAt = new Date(form.runAt);
  if (Number.isNaN(runAt.getTime())) {
    throw new Error('请选择合法的开始时间');
  }
  const projectName = projectLabel(projects, form.projectId);
  const payload = {
    name: `${form.mode === 'daily' ? '每日' : '定时'}运行 Triage - ${projectName}`,
    project_id: form.projectId,
    action: CRON_ACTION_TRIAGE_TO_TODO,
    mode: form.mode,
  };
  if (form.mode === 'daily') {
    payload.time_of_day = form.runAt.slice(11, 16);
  } else {
    payload.next_run_at = runAt.toISOString();
  }
  return payload;
}

function projectLabel(projects, projectId) {
  if (!projectId) return '所有项目';
  return projects.find(project => project.id === projectId)?.name || projectId;
}
