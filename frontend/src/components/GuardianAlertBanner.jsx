import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, TimerReset, WifiOff } from 'lucide-react';
import { api } from '../api/client';
import {
  selectGuardianAlerts,
  selectSetGuardianAlerts,
  useDataStore,
} from '../store/dataStore';
import { RECONCILE_INTERVAL_MS } from '../utils/stateGuards';

const ALERT_TYPE_LABELS = {
  approval_fast_path_error: 'Approval fast-path error',
  coordinator_stalled: 'Coordinator stalled',
  digest_flush_stalled: 'Digest flush stalled',
  guardian_inbox_stalled: 'Guardian inbox stalled',
  outbox_stalled: 'Outbox stalled',
  pi_runtime_down: 'PI runtime down',
  scheduler_watchdog_stale: 'Scheduler watchdog stale',
};

export default function GuardianAlertBanner() {
  const alerts = useDataStore(selectGuardianAlerts);
  const setGuardianAlerts = useDataStore(selectSetGuardianAlerts);
  const status = useGuardianStatus();
  const [ackedIds, setAckedIds] = useState(() => new Set());
  const [ackingId, setAckingId] = useState('');
  const [ackError, setAckError] = useState('');

  const visibleAlerts = useMemo(() => visibleOpenAlerts(alerts, ackedIds), [ackedIds, alerts]);
  const watchdog = status.data?.pi_guardian?.watchdog ?? null;
  const watchdogStale = Boolean(watchdog?.is_stale);

  const refreshAlerts = useCallback(async () => {
    try {
      setGuardianAlerts(await api.getPiGuardianAlerts());
    } catch {
      setGuardianAlerts([]);
    }
  }, [setGuardianAlerts]);
  const handleRefresh = useCallback(() => {
    refreshAlerts();
    status.reload();
  }, [refreshAlerts, status]);
  const handleAck = useCallback(async (id) => {
    setAckingId(id);
    setAckError('');
    try {
      const alert = await api.ackPiGuardianAlert(id);
      if (alert?.status !== 'open') {
        setAckedIds((current) => new Set(current).add(id));
      }
      await refreshAlerts();
    } catch (error) {
      setAckError(errorMessage(error));
    } finally {
      setAckingId('');
    }
  }, [refreshAlerts]);

  useEffect(() => {
    refreshAlerts();
    const interval = setInterval(refreshAlerts, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAlerts]);

  if (visibleAlerts.length === 0 && !watchdogStale && !status.error && !ackError) return null;

  return (
    <section className="guardian-alert-stack" aria-label="Guardian system alerts" aria-live="polite">
      {watchdogStale ? <WatchdogStaleBanner loading={status.loading} onRefresh={handleRefresh} watchdog={watchdog} /> : null}
      {visibleAlerts.map((alert) => (
        <GuardianAlertItem alert={alert} acking={ackingId === alert.id} key={alert.id} onAck={handleAck} />
      ))}
      {status.error ? <GuardianStatusError error={status.error} loading={status.loading} onRefresh={handleRefresh} /> : null}
      {ackError ? <p className="guardian-alert-inline-error" role="alert">Ack 失败：{ackError}</p> : null}
    </section>
  );
}

function useGuardianStatus() {
  const [state, setState] = useState({ data: null, error: '', loading: false });
  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await api.getSystemStatus();
      setState({ data, error: '', loading: false });
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error), loading: false }));
    }
  }, []);

  useEffect(() => {
    reload();
    const interval = setInterval(reload, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  return { ...state, reload };
}

function GuardianAlertItem({ alert, acking, onAck }) {
  const urgent = alert.severity === 'urgent';
  return (
    <article className={`guardian-alert-banner ${urgent ? 'urgent' : 'watch'}`}>
      <div className="guardian-alert-icon"><ShieldAlert size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row">
          <strong>{alertTitle(alert)}</strong>
          <span className={`guardian-alert-severity ${urgent ? 'urgent' : ''}`}>{alert.severity || 'watch'}</span>
        </div>
        <p>{alert.message || 'Guardian watchdog reported an open system alert.'}</p>
        <small>{alertMeta(alert)}</small>
      </div>
      <button className="guardian-alert-action" disabled={acking} onClick={() => onAck(alert.id)} type="button">
        {acking ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
        Ack
      </button>
    </article>
  );
}

function WatchdogStaleBanner({ loading, onRefresh, watchdog }) {
  const staleAfter = watchdog?.stale_after ? `stale_after ${formatDate(watchdog.stale_after)}` : 'stale_after unknown';
  const lastSeen = watchdog?.last_seen ? `last_seen ${formatDate(watchdog.last_seen)}` : 'last_seen missing';
  return (
    <article className="guardian-alert-banner stale">
      <div className="guardian-alert-icon"><TimerReset size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row"><strong>Guardian watchdog stale</strong></div>
        <p>Watchdog liveness 已过期，Runner UI 是当前主带外通道。</p>
        <small>{lastSeen} · {staleAfter}</small>
      </div>
      <button className="guardian-alert-action" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />
        Refresh
      </button>
    </article>
  );
}

function GuardianStatusError({ error, loading, onRefresh }) {
  return (
    <article className="guardian-alert-banner degraded">
      <div className="guardian-alert-icon"><WifiOff size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row"><strong>Guardian status unavailable</strong></div>
        <p>无法读取 Guardian system status；页面保持可用，请检查后端连接或 500 错误。</p>
        <small>{error}</small>
      </div>
      <button className="guardian-alert-action" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />
        Retry
      </button>
    </article>
  );
}

function visibleOpenAlerts(alerts, ackedIds) {
  if (!Array.isArray(alerts)) return [];
  return alerts
    .filter((alert) => alert?.status === 'open' && alert.ui_visible !== 0 && !ackedIds.has(alert.id))
    .sort((left, right) => alertRank(left) - alertRank(right));
}

function alertRank(alert) {
  return alert?.severity === 'urgent' ? 0 : 1;
}

function alertTitle(alert) {
  return ALERT_TYPE_LABELS[alert.alert_type] || alert.alert_type || 'Guardian alert';
}

function alertMeta(alert) {
  const parts = [
    alert.project_id ? `project ${alert.project_id}` : '',
    alert.issue_id ? `issue #${alert.issue_id}` : '',
    alert.watchdog_seen_at ? `seen ${formatDate(alert.watchdog_seen_at)}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Guardian system alert';
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}
