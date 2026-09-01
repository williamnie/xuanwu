import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, ShieldCheck, X } from 'lucide-react';
import { systemApi } from '../api/system.js';
import { message } from '../store/toastStore.js';
import './ReleaseUpdateDialog.css';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 6 * 60 * 60 * 1000;
const SNOOZE_KEY = 'xuanwu-release-update-snooze-v1';
const ACTIVE_JOB_STATES = new Set(['pending', 'running']);

export default function ReleaseUpdateDialog({ onOpenSettings }) {
  const [data, setData] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [snoozeState, setSnoozeState] = useState(readSnooze);
  const dialogRef = useRef(null);
  const primaryRef = useRef(null);
  const check = useCallback(async (refresh = false) => {
    try {
      const next = await systemApi.getReleaseUpdate({ refresh });
      setData(next);
      setClock(Date.now());
      if (!next?.update_available) setSnoozeState({ until: 0, version: '' });
    } catch {
      // 更新检查不能遮挡或降级正常工作台。
    }
  }, []);

  useEffect(() => {
    void check(false);
    const timer = setInterval(() => { void check(true); }, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check]);

  const version = String(data?.latest || '');
  const visible = Boolean(
    data?.supported && data?.update_available && version &&
    !ACTIVE_JOB_STATES.has(data?.job?.state) &&
    !(snoozeState.version === version && snoozeState.until > clock)
  );

  useEffect(() => {
    if (snoozeState.version !== version || snoozeState.until <= Date.now()) return undefined;
    const timer = setTimeout(() => setSnoozeState({ until: 0, version: '' }), snoozeState.until - Date.now());
    return () => clearTimeout(timer);
  }, [snoozeState, version]);

  useEffect(() => {
    if (!visible) return undefined;
    const previousOverflow = document.body.style.overflow;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const frame = globalThis.requestAnimationFrame?.(() => primaryRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        snooze(version, setSnoozeState);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll(focusableSelector) || []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (frame) globalThis.cancelAnimationFrame?.(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [version, visible]);

  const startUpgrade = useCallback(async () => {
    if (!version || submitting) return;
    setSubmitting(true);
    try {
      await systemApi.startReleaseUpdate(version);
      snooze(version, setSnoozeState);
      message.success('升级任务已启动，将先完成备份与恢复演练');
      onOpenSettings?.();
    } catch (error) {
      message.error(error.message || '启动升级失败');
    } finally {
      setSubmitting(false);
    }
  }, [onOpenSettings, submitting, version]);

  if (!visible) return null;
  return (
    <div className="release-update-dialog__backdrop">
      <section aria-labelledby="release-update-dialog-title" aria-modal="true" className="release-update-dialog" ref={dialogRef} role="dialog">
        <button aria-label="稍后提醒" className="release-update-dialog__close" onClick={() => snooze(version, setSnoozeState)} type="button">
          <X aria-hidden="true" size={14} />
        </button>
        <div className="release-update-dialog__icon"><ShieldCheck aria-hidden="true" size={16} /></div>
        <div className="release-update-dialog__eyebrow">RELEASE UPDATE</div>
        <h2 id="release-update-dialog-title">玄武新版本 {version}</h2>
        <p>当前版本 {data.current}。建议现在升级，系统会先生成备份并完成隔离恢复演练，随后服务会短暂重启。</p>
        <div className="release-update-dialog__facts">
          <span>备份校验</span><strong>REQUIRED</strong>
          <span>失败策略</span><strong>ROLLBACK</strong>
        </div>
        <div className="release-update-dialog__actions">
          <button className="btn btn-primary" disabled={submitting} onClick={startUpgrade} ref={primaryRef} type="button">
            {submitting ? <Loader2 aria-hidden="true" className="spin-animation" size={13} /> : <Download aria-hidden="true" size={13} />}
            立即升级
          </button>
          <button className="btn btn-secondary" disabled={submitting} onClick={() => snooze(version, setSnoozeState)} type="button">稍后提醒</button>
        </div>
      </section>
    </div>
  );
}

function snooze(version, setSnoozeState) {
  const value = { until: Date.now() + SNOOZE_MS, version };
  setSnoozeState(value);
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(value));
  } catch {
    // 当前会话的 snoozeState 仍能避免重复弹出。
  }
}

function readSnooze() {
  try {
    const value = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}');
    return { until: Number(value?.until) || 0, version: String(value?.version || '') };
  } catch {
    return { until: 0, version: '' };
  }
}
