import { systemApi } from '../api/system.js';
import { assistantApi } from '../api/assistant.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, TimerReset, WifiOff } from 'lucide-react';
import {
  selectGuardianAlerts,
  selectSetGuardianAlerts,
  useDataStore,
} from '../store/dataStore';
import { RECONCILE_INTERVAL_MS } from '../utils/stateGuards';
import { buildGuardianAlertDisplay } from './guardianAlertDisplay';

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
      setGuardianAlerts(await assistantApi.getPiGuardianAlerts());
    } catch {
      setGuardianAlerts([]);
    }
  }, [setGuardianAlerts]);
  const handleRefresh = useCallback(() => {
    refreshAlerts();
    status.reload({ force: true });
  }, [refreshAlerts, status]);
  const handleAck = useCallback(async (id) => {
    setAckingId(id);
    setAckError('');
    try {
      const alert = await assistantApi.ackPiGuardianAlert(id);
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
    <section className="guardian-alert-stack" aria-label="Guardian 系统告警" aria-live="polite">
      {watchdogStale ? <WatchdogStaleBanner loading={status.loading} onRefresh={handleRefresh} watchdog={watchdog} /> : null}
      {visibleAlerts.map((alert) => (
        <GuardianAlertItem alert={alert} acking={ackingId === alert.id} key={alert.id} onAck={handleAck} />
      ))}
      {status.error ? <GuardianStatusError error={status.error} loading={status.loading} onRefresh={handleRefresh} /> : null}
      {ackError ? <p className="guardian-alert-inline-error" role="alert">确认失败：{ackError}</p> : null}
    </section>
  );
}

function useGuardianStatus() {
  const [state, setState] = useState({ data: null, error: '', loading: false });
  const reload = useCallback(async ({ force = false } = {}) => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await systemApi.getSystemStatus({ force });
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
  const display = buildGuardianAlertDisplay(alert);
  return (
    <article className={`guardian-alert-banner ${urgent ? 'urgent' : 'watch'}`}>
      <div className="guardian-alert-icon"><ShieldAlert size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row">
          <strong>{display.title}</strong>
          <span className={`guardian-alert-severity ${urgent ? 'urgent' : ''}`}>{display.severityLabel}</span>
        </div>
        <p>{display.message}</p>
        {display.userAction ? <p className="guardian-alert-user-action"><strong>需要你做：</strong>{display.userAction}</p> : null}
        <small>{display.meta}</small>
      </div>
      <button className="guardian-alert-action" disabled={acking} onClick={() => onAck(alert.id)} type="button">
        {acking ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
        已知晓
      </button>
    </article>
  );
}

function WatchdogStaleBanner({ loading, onRefresh, watchdog }) {
  const staleAfter = watchdog?.stale_after ? `过期阈值 ${formatDate(watchdog.stale_after)}` : '过期阈值未知';
  const lastSeen = watchdog?.last_seen ? `最近心跳 ${formatDate(watchdog.last_seen)}` : '最近心跳缺失';
  return (
    <article className="guardian-alert-banner stale">
      <div className="guardian-alert-icon"><TimerReset size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row"><strong>Guardian 心跳已超时</strong></div>
        <p>Guardian 心跳已超过预期，自动告警可能延迟。请刷新状态；如持续出现，请检查 scheduler/watchdog 进程。</p>
        <small>{lastSeen} · {staleAfter}</small>
      </div>
      <button className="guardian-alert-action" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />
        刷新
      </button>
    </article>
  );
}

function GuardianStatusError({ error, loading, onRefresh }) {
  return (
    <article className="guardian-alert-banner degraded">
      <div className="guardian-alert-icon"><WifiOff size={18} /></div>
      <div className="guardian-alert-body">
        <div className="guardian-alert-title-row"><strong>无法读取 Guardian 状态</strong></div>
        <p>页面保持可用，但告警状态可能不是最新。请检查后端连接或服务错误后重试。</p>
        <small>{error}</small>
      </div>
      <button className="guardian-alert-action" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />
        重试
      </button>
    </article>
  );
}

function visibleOpenAlerts(alerts, ackedIds) {
  if (!Array.isArray(alerts)) return [];
  return alerts
    .filter((alert) => alert?.status === 'open' && alert.ui_visible !== 0 && !ackedIds.has(alert.id))
    .filter((alert) => buildGuardianAlertDisplay(alert).requiresUser)
    .sort((left, right) => alertRank(left) - alertRank(right));
}

function alertRank(alert) {
  return alert?.severity === 'urgent' ? 0 : 1;
}

function formatDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}
