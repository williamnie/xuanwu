import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { systemApi } from '../api/system.js';
import { message } from '../store/toastStore.js';
import './ReleaseUpdatePanel.css';

const ACTIVE_STATES = new Set(['pending', 'running']);
const POLL_INTERVAL_MS = 2_000;

export default function ReleaseUpdatePanel() {
  const state = useReleaseUpdate();
  if (!state.data && state.loading) return <ReleaseUpdateLoading />;
  const data = state.data || {};
  const job = data.job || null;
  const active = ACTIVE_STATES.has(job?.state);
  return (
    <section className="settings-release-update" aria-label="玄武升级">
      <ReleaseUpdateHeader loading={state.loading} onRefresh={() => state.load(true)} />
      {state.error || data.check_error ? <div className="settings-release-update__error" role="alert">{state.error || data.check_error}</div> : null}
      <div className="settings-release-update__facts">
        <ReleaseFact label="CURRENT" value={data.current || job?.from_version || 'unknown'} />
        <ReleaseFact label="LATEST" value={data.latest || job?.target_version || 'unknown'} />
        <ReleaseFact label="STATUS" value={releaseStatus(data, job)} tone={releaseTone(data, job)} />
      </div>
      <ReleaseUpdateBody active={active} data={data} job={job} state={state} />
    </section>
  );
}

function useReleaseUpdate() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(async (refresh = false, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await systemApi.getReleaseUpdate({ refresh }));
      setError('');
    } catch (loadError) {
      if (!quiet) setError(loadError.message || '读取升级状态失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!ACTIVE_STATES.has(data?.job?.state)) return undefined;
    const timer = setInterval(() => { void load(false, true); }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [data?.job?.state, load]);
  const start = useCallback(async () => {
    const version = data?.latest;
    if (!version || submitting) return;
    setSubmitting(true);
    try {
      const accepted = await systemApi.startReleaseUpdate(version);
      setData((current) => ({ ...current, job: accepted.job }));
      setConfirming(false);
      setError('');
      message.success('升级任务已启动，将先完成备份与恢复演练');
    } catch (startError) {
      setError(startError.message || '启动升级失败');
    } finally {
      setSubmitting(false);
    }
  }, [data?.latest, submitting]);
  return { confirming, data, error, load, loading, setConfirming, start, submitting };
}

function ReleaseUpdateHeader({ loading, onRefresh }) {
  return (
    <header className="settings-release-update__header">
      <div>
        <div className="settings-release-update__eyebrow">RELEASE UPDATE</div>
        <h2><Download aria-hidden="true" size={16} />安全升级</h2>
        <p>自动完成备份、校验、隔离恢复演练、安装、健康检查；失败时恢复上一份 Release。</p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw aria-hidden="true" className={loading ? 'spin-animation' : ''} size={14} />检查更新
      </button>
    </header>
  );
}

function ReleaseUpdateBody({ active, data, job, state }) {
  if (!data.supported) {
    return <p className="settings-release-update__note">源码开发环境不执行自身升级；请使用 Release 安装版中的独立 updater。</p>;
  }
  if (active) {
    return (
      <div className="settings-release-update__running" aria-live="polite">
        <Loader2 aria-hidden="true" className="spin-animation" size={15} />
        <div><strong>{job.state === 'pending' ? '等待升级服务接管' : '正在执行安全升级'}</strong><span>过程中页面可能短暂断开，服务重启后会自动恢复状态。</span></div>
      </div>
    );
  }
  if (job?.state === 'failed') {
    return (
      <div className="settings-release-update__result is-error">
        <AlertTriangle aria-hidden="true" size={15} />
        <div><strong>升级未完成</strong><span>错误代码：{job.error_code || 'unknown'}。已保留升级日志和可用备份，请检查后重试。</span></div>
      </div>
    );
  }
  if (job?.state === 'succeeded') {
    return (
      <div className="settings-release-update__result is-success">
        <CheckCircle2 aria-hidden="true" size={15} />
        <div><strong>升级完成</strong><span>已升级到 {job.target_version}；备份保留在本机状态目录。</span></div>
      </div>
    );
  }
  if (!data.update_available) {
    return <div className="settings-release-update__current"><CheckCircle2 aria-hidden="true" size={15} /><span>当前已经是最新 Release。</span></div>;
  }
  if (state.confirming) {
    return (
      <div className="settings-release-update__confirm" role="alert">
        <ShieldCheck aria-hidden="true" size={16} />
        <div><strong>升级到 {data.latest}？</strong><span>任务会先生成可验证备份并完成隔离恢复演练，随后服务会短暂重启。</span></div>
        <div className="settings-release-update__actions">
          <button className="btn btn-primary" disabled={state.submitting} onClick={state.start} type="button">
            {state.submitting ? <Loader2 aria-hidden="true" className="spin-animation" size={13} /> : <Download aria-hidden="true" size={13} />}
            确认升级
          </button>
          <button className="btn btn-secondary" disabled={state.submitting} onClick={() => state.setConfirming(false)} type="button">取消</button>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-release-update__available">
      <div><strong>发现新版本 {data.latest}</strong><span>升级由独立 OS 用户服务执行，不依赖正在重启的 Runner Core。</span></div>
      <button className="btn btn-primary" onClick={() => state.setConfirming(true)} type="button"><Download aria-hidden="true" size={13} />立即升级</button>
    </div>
  );
}

function ReleaseFact({ label, tone = '', value }) {
  return <div className={`settings-release-update__fact${tone ? ` ${tone}` : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ReleaseUpdateLoading() {
  return <section className="settings-release-update settings-release-update__loading"><Loader2 aria-hidden="true" className="spin-animation" size={15} />正在读取 Release 状态…</section>;
}

function releaseStatus(data, job) {
  if (ACTIVE_STATES.has(job?.state)) return job.state;
  if (job?.state === 'failed' || job?.state === 'succeeded') return job.state;
  if (!data.supported) return 'unsupported';
  return data.update_available ? 'available' : 'current';
}

function releaseTone(data, job) {
  const status = releaseStatus(data, job);
  if (status === 'failed') return 'is-error';
  if (status === 'succeeded' || status === 'current') return 'is-success';
  if (status === 'available' || ACTIVE_STATES.has(status)) return 'is-warning';
  return '';
}
