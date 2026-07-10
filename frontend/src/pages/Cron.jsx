import { CalendarClock, CheckCircle2, PauseCircle, PlayCircle } from 'lucide-react';
import CronTasksPanel from '../components/CronTasksPanel';
import {
  selectCronTasks,
  selectProjects,
  useDataStore,
} from '../store/dataStore';

function countByStatus(tasks, status) {
  return tasks.filter(task => task.status === status).length;
}

function nextActiveRun(tasks) {
  const timestamps = tasks
    .filter(task => task.status === 'active' && task.next_run_at)
    .map(task => new Date(task.next_run_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (timestamps.length === 0) return '—';
  return new Date(timestamps[0]).toLocaleString();
}

export default function Cron() {
  const cronTasks = useDataStore(selectCronTasks);
  const projects = useDataStore(selectProjects);
  const activeCount = countByStatus(cronTasks, 'active');
  const pausedCount = countByStatus(cronTasks, 'paused');
  const doneCount = countByStatus(cronTasks, 'done');

  return (
    <div className="cron-page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      <div className="page-intro" style={{ flexShrink: 0, padding: '24px 0 8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '20px' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <CalendarClock size={28} color="var(--primary)" /> Cron
          </h1>
          <p style={{ color: 'var(--text-muted)' }}>
            管理 Triage 定时队列：查看、创建、暂停/恢复和删除当前 cron 任务。
          </p>
        </div>
        <div className="status-badge todo" style={{ padding: '6px 10px' }}>
          下一次运行：{nextActiveRun(cronTasks)}
        </div>
      </div>

      <div className="grid-cols-3" style={{ flexShrink: 0 }}>
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '10px', borderRadius: '12px', background: 'var(--success-glow)', color: 'var(--success)' }}>
            <PlayCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, lineHeight: 1 }}>{activeCount}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>Active cron</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '10px', borderRadius: '12px', background: 'var(--warning-glow)', color: 'var(--warning)' }}>
            <PauseCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, lineHeight: 1 }}>{pausedCount}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>Paused cron</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '10px', borderRadius: '12px', background: 'var(--primary-glow)', color: 'var(--primary)' }}>
            <CheckCircle2 size={22} />
          </div>
          <div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, lineHeight: 1 }}>{doneCount}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
              Done cron · {projects.length} projects
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: '24px' }}>
        <CronTasksPanel />
      </div>
    </div>
  );
}
