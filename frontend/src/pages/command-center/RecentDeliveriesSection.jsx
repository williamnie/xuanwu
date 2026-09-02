import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { message as toast } from '../../store/toastStore.js';
import { displayRef } from '../handoffPageModel.js';
import { recentDeliveryView } from './recentDeliveriesModel.js';
import './RecentDeliveriesSection.css';

const RECENT_DELIVERY_LIMIT = 5;
const REFRESH_INTERVAL_MS = 30_000;

export default function RecentDeliveriesSection({ navigateTo, projects = [] }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const requestRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (requestRef.current) return requestRef.current.promise;
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const promise = commandCenterApi.getSummary({
      limit: RECENT_DELIVERY_LIMIT,
      sections: ['recent_deliveries'],
    }, { signal: controller.signal });
    requestRef.current = { controller, promise };
    try {
      const response = await promise;
      const section = response?.sections?.recent_deliveries;
      if (!section || section.status !== 'ok') {
        throw new Error(section?.error?.message || 'Recent Deliveries 分区暂不可用');
      }
      const snapshots = Array.isArray(section.items) ? section.items : [];
      setSummary({
        compatibility: response.compatibility || null,
        detailFailures: 0,
        section: { ...section, items: snapshots },
      });
      setError('');
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError.message || '加载 Recent Deliveries 失败');
    } finally {
      if (requestRef.current?.promise === promise) requestRef.current = null;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    load();
    return () => {
      const activeRequest = requestRef.current;
      requestRef.current = null;
      activeRequest?.controller.abort();
    };
  }, [load, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const interval = window.setInterval(() => load({ silent: true }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let timer = 0;
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (timer || event.type !== 'handoff.notification') return;
      timer = window.setTimeout(() => {
        timer = 0;
        load({ silent: true });
      }, 250);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load, visible]);

  const projectNames = useMemo(
    () => new Map(projects.map(project => [project.id, project.name])),
    [projects],
  );
  const items = summary?.section?.items || [];

  const openHandoff = (item) => {
    const route = recentDeliveryView(item).detailRoute;
    if (!route) {
      toast.error('Handoff 链接无效，已阻止打开');
      return;
    }
    globalThis.history?.replaceState?.(null, '', item.links.view);
    navigateTo?.(route.page, route.workId || item.work_id, '', route.handoffId);
  };

  const copyRef = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error(`${label} 复制失败`);
    }
  };

  return (
    <section className="recent-deliveries-section" aria-busy={visible && loading}>
      <header className="recent-deliveries-header">
        <div>
          <div className="recent-deliveries-kicker"><PackageCheck size={15} /> Recent Deliveries</div>
          <h3>最近交付</h3>
          <p>Handoff、Evidence、review 与不可变交付引用的最新状态。</p>
        </div>
        <div className="recent-deliveries-header-actions">
          {summary?.section?.freshness?.is_stale || summary?.detailFailures > 0 ? (
            <span className="recent-deliveries-freshness stale" title={summary?.detailFailures > 0 ? '部分 Handoff detail 刷新失败，当前显示聚合快照' : ''}>
              <AlertTriangle size={13} /> {summary?.detailFailures > 0 ? '部分状态未刷新' : '数据可能过期'}
            </span>
          ) : null}
          <span className="recent-deliveries-count">{summary?.section?.counts?.total ?? items.length}</span>
          <button aria-label="刷新 Recent Deliveries" disabled={!visible || loading} onClick={() => load()} type="button">
            <RefreshCw className={loading ? 'is-spinning' : ''} size={15} />
          </button>
        </div>
      </header>

      {!visible ? (
        <div className="recent-deliveries-state empty">
          <strong>最近交付按需读取，不阻塞工作台首屏</strong>
          <button onClick={() => setVisible(true)} type="button">加载最近交付</button>
        </div>
      ) : error ? (
        <div className="recent-deliveries-state error" role="alert">
          <AlertTriangle size={18} />
          <div><strong>Recent Deliveries 暂不可用</strong><span>{error}</span></div>
          <button onClick={() => load()} type="button">重试</button>
        </div>
      ) : loading && !summary ? (
        <div className="recent-deliveries-state empty">
          <RefreshCw className="is-spinning" size={20} />
          <strong>正在读取最近交付…</strong>
        </div>
      ) : items.length === 0 ? (
        <div className="recent-deliveries-state empty">
          <PackageCheck size={24} />
          <strong>还没有 Handoff 交付</strong>
          <span>形成 draft、ready 或 delivered Handoff 后会显示在这里。</span>
          <button onClick={() => navigateTo?.('work')} type="button">打开 Work Board</button>
        </div>
      ) : (
        <div aria-label="最近交付列表" className="recent-deliveries-list" role="region" tabIndex={0}>
          {items.map(item => {
            const view = recentDeliveryView(item);
            return (
              <article className={`recent-delivery-card ${view.statusTone}`} key={item.id}>
                <div className="recent-delivery-topline">
                  <span className="recent-delivery-project">{projectNames.get(item.project_id) || item.project_id}</span>
                  <span className="recent-delivery-status" data-tone={view.statusTone}><i />{view.statusLabel}</span>
                </div>

                <button className="recent-delivery-title" onClick={() => openHandoff(item)} type="button">
                  {item.issue?.id ? `#${item.issue.id} ` : ''}{item.issue?.title || item.summary}
                </button>

                <p className="recent-delivery-summary">{view.modeLabel} · {view.statusLabel}</p>

                <div className="recent-delivery-badges">
                  <span className={view.evidencePassed ? 'evidence passed' : 'evidence'}>
                    <CheckCircle2 size={12} /> {view.evidenceLabel}
                  </span>
                  <span className={view.riskCount > 0 ? 'risk active' : 'risk'}>
                    <ShieldAlert size={12} /> {view.riskLabel}
                  </span>
                </div>

                <div className="recent-delivery-status-grid">
                  <div><span>Mode</span><strong>{view.modeLabel}</strong></div>
                  <div><span>Review</span><strong data-state={view.reviewState}>{view.reviewLabel}</strong></div>
                  <div><span>{view.operationLabel}</span><strong data-state={view.status}>{view.statusLabel}</strong></div>
                </div>

                <div className="recent-delivery-refs">
                  {view.refs.slice(-2).map(ref => (
                    <div key={`${ref.label}:${ref.value}`}>
                      <span>{ref.label}</span>
                      <code title={ref.value}>{displayRef(ref.value, 18, 9)}</code>
                    </div>
                  ))}
                </div>

                <div className="recent-delivery-actions">
                  <button onClick={() => copyRef(view.primaryRef, view.refs.at(-1)?.label || 'Handoff ID')} type="button">
                    <Copy size={12} /> Copy ref
                  </button>
                  {view.externalHref ? (
                    <a href={view.externalHref} rel="noreferrer noopener" target="_blank"><ExternalLink size={12} /> Open PR</a>
                  ) : null}
                  <button className="open" onClick={() => openHandoff(item)} type="button">
                    打开 <ArrowUpRight size={13} />
                  </button>
                </div>

                <footer>
                  <GitCommitHorizontal size={12} />
                  <span>{formatTime(item.updated_at)}</span>
                  {item.delivery_status?.refreshed_at ? <span>状态刷新于 {formatTime(item.delivery_status.refreshed_at)}</span> : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {summary?.compatibility ? (
        <details className="recent-deliveries-compatibility">
          <summary>数据来源与迁移</summary>
          <span>Handoff source of truth: {summary.compatibility.handoff_read_authority}</span>
          <span>双写：{summary.compatibility.dual_write}；双读：{summary.compatibility.dual_read}</span>
          <span>回滚：{summary.compatibility.rollback}</span>
          <span>最终删除门禁：{summary.compatibility.final_removal_gate}</span>
        </details>
      ) : null}
    </section>
  );
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
