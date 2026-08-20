import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Clock3,
  Pause,
  RefreshCw,
  Square,
} from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { runsApi } from '../../api/runs.js';
import { workApi } from '../../api/work.js';
import { message as toast } from '../../store/toastStore.js';
import { buildRunControlPayload } from '../runs/runPageModel.js';
import {
  activeWorkCanPause,
  activeWorkCanStop,
  activeWorkHasActiveRun,
  activeWorkView,
  buildActiveWorkActionPayload,
  formatRelativeTime,
} from './activeWorkModel.js';
import './ActiveWorkSection.css';

const REFRESH_INTERVAL_MS = 30_000;
const REFRESH_EVENT_TYPES = new Set([
  'issue.runtime_updated',
  'issue.status_changed',
  'run.lifecycle.intent.v1',
  'run.lifecycle.outcome.v1',
  'run.lifecycle.run_materialized.v1',
]);

export default function ActiveWorkSection({ navigateTo, projects = [] }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const requestRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (requestRef.current) {
      try { await requestRef.current.promise; } catch { /* owning request handles its result */ }
      return;
    }
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const promise = commandCenterApi.getSummary(
      { limit: 10, sections: ['active_work'] },
      { signal: controller.signal },
    );
    requestRef.current = { controller, promise };
    try {
      const response = await promise;
      const section = response?.sections?.active_work;
      if (!section || section.status !== 'ok') {
        throw new Error(section?.error?.message || 'Active Work 分区暂不可用');
      }
      setSummary({ compatibility: response.compatibility || null, section });
      setError('');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || '加载 Active Work 失败');
    } finally {
      if (requestRef.current?.promise === promise) requestRef.current = null;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => requestRef.current?.controller.abort();
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => load({ silent: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (timer || !REFRESH_EVENT_TYPES.has(event.type)) return;
      timer = window.setTimeout(() => {
        timer = 0;
        load({ silent: true });
      }, 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const projectNames = useMemo(
    () => new Map(projects.map(project => [project.id, project.name])),
    [projects],
  );
  const items = summary?.section?.items || [];

  const openWork = (item) => {
    if (item.latest_run?.id) {
      navigateTo?.('runs', null, item.latest_run.id);
      return;
    }
    navigateTo?.('work');
  };

  const submitAction = async () => {
    if (!pending || submitting) return;
    const item = items.find(candidate => candidate.id === pending.id);
    if (!item) return;
    setSubmitting(true);
    try {
      if (pending.action === 'pause') {
        const detail = await loadRunDetail(item.latest_run?.id);
        if (!activeWorkCanPause(item, detail)) {
          throw new Error('当前 Run 没有可暂停的活动 provider turn，请打开 Run 查看最新状态');
        }
        const nonce = randomEventId();
        await runsApi.controlRun(item.latest_run.id, 'interrupt', buildRunControlPayload(detail, 'interrupt', {
          correlationPrefix: 'command-center',
          eventId: `command-center:pause:${nonce}`,
          reasonPrefix: 'Dashboard Active Work',
        }));
        toast.success('Run 暂停已审计提交');
      } else {
        await workApi.controlWork(item.id, 'cancel', buildActiveWorkActionPayload(item, 'cancel'));
        toast.success('Work 停止已审计提交');
      }
      setPending(null);
      await load({ silent: true });
    } catch (actionError) {
      toast.error(actionError.message || 'Active Work 操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="active-work-section" aria-busy={loading}>
      <header className="active-work-header">
        <div>
          <div className="active-work-kicker"><Clock3 size={15} /> Active Work</div>
          <h3>进行中的工作</h3>
          <p>运行、排队、验证与恢复中的 Work，以及最新可审计进展。</p>
        </div>
        <div className="active-work-header-actions">
          {summary?.section?.freshness?.is_stale ? (
            <span className="active-work-freshness stale"><AlertTriangle size={13} /> 数据可能过期</span>
          ) : null}
          <span className="active-work-count">{summary?.section?.counts?.total ?? items.length}</span>
          <button aria-label="刷新 Active Work" disabled={loading} onClick={() => load()} type="button">
            <RefreshCw className={loading ? 'is-spinning' : ''} size={15} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="active-work-state error" role="alert">
          <AlertTriangle size={18} />
          <div><strong>Active Work 暂不可用</strong><span>{error}</span></div>
          <button onClick={() => load()} type="button">重试</button>
        </div>
      ) : loading && !summary ? (
        <div className="active-work-state empty">
          <RefreshCw className="is-spinning" size={20} />
          <strong>正在读取 Active Work…</strong>
        </div>
      ) : items.length === 0 ? (
        <div className="active-work-state empty">
          <Clock3 size={22} />
          <strong>当前没有 Active Work</strong>
          <span>排队、运行、验证或恢复中的 Work 会出现在这里。</span>
        </div>
      ) : (
        <div className="active-work-list">
          {items.map(item => {
            const detail = null;
            const view = activeWorkView(item, detail);
            const confirmation = pending?.id === item.id ? pending.action : '';
            return (
              <article className={`active-work-card ${view.tone} ${view.stalled ? 'is-stalled' : ''}`} key={item.id}>
                <div className="active-work-card-topline">
                  <span className="active-work-project">{projectNames.get(item.project_id) || item.project_id}</span>
                  <span className={`active-work-phase ${view.tone}`}><i />{view.phaseLabel}</span>
                </div>
                <button className="active-work-title" onClick={() => openWork(item)} type="button">{item.title}</button>
                <div className="active-work-progress">
                  <span className="active-work-progress-label">LATEST</span>
                  <span>{view.progressText}</span>
                </div>
                {item.readiness && item.readiness.status !== 'not_required' ? (
                  <div className="active-work-readiness" data-status={item.readiness?.status}>
                    <span>READINESS</span>
                    <strong>{item.readiness?.current_stage || 'waiting_source'}</strong>
                    <em>{item.readiness?.missing_evidence?.[0] || item.readiness?.next_step}</em>
                  </div>
                ) : null}
                <div className="active-work-meta">
                  <span><Clock3 size={13} /> {view.duration}</span>
                  {view.progressAt ? <span>更新于 {formatRelativeTime(view.progressAt)}</span> : null}
                  {view.stalled ? <span className="active-work-stalled"><AlertTriangle size={12} /> {view.stalledLabel}</span> : null}
                </div>
                <div className="active-work-actions">
                  {activeWorkHasActiveRun(item) ? (
                    <button
                      disabled={Boolean(detail) && !activeWorkCanPause(item, detail)}
                      onClick={() => setPending({ action: 'pause', id: item.id })}
                      title={Boolean(detail) && !activeWorkCanPause(item, detail) ? '当前 Run 没有活动 provider turn' : '暂停当前 Run Attempt'}
                      type="button"
                    >
                      <Pause size={13} /> 暂停
                    </button>
                  ) : null}
                  {activeWorkCanStop(item) ? (
                    <button className="danger" onClick={() => setPending({ action: 'stop', id: item.id })} type="button">
                      <Square size={12} /> 停止
                    </button>
                  ) : null}
                  <button className="open" onClick={() => openWork(item)} type="button">
                    打开 <ArrowUpRight size={13} />
                  </button>
                </div>
                {confirmation ? (
                  <div className="active-work-confirm" role="group" aria-label={`确认${confirmation === 'pause' ? '暂停' : '停止'} Work`}>
                    <span>{confirmation === 'pause' ? '暂停当前 Run Attempt？可在 Runs 中继续或重试。' : '停止整个 Work？此操作会取消其执行队列。'}</span>
                    <div>
                      <button disabled={submitting} onClick={() => setPending(null)} type="button">取消</button>
                      <button className="confirm" disabled={submitting} onClick={submitAction} type="button">
                        {submitting ? '提交中…' : '确认提交'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {summary?.compatibility ? (
        <details className="active-work-compatibility">
          <summary>数据来源与迁移</summary>
          <span>Work source of truth: {summary.compatibility.work_read_authority}</span>
          <span>Run source of truth: {summary.compatibility.run_read_authority}</span>
          <span>双写：{summary.compatibility.dual_write}；双读：{summary.compatibility.dual_read}</span>
          <span>回滚：{summary.compatibility.rollback}</span>
          <span>最终删除门禁：{summary.compatibility.final_removal_gate}</span>
        </details>
      ) : null}
    </section>
  );
}

async function loadRunDetail(id) {
  if (!id) return null;
  const response = await runsApi.getRun(id);
  return response?.run || null;
}

function randomEventId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
