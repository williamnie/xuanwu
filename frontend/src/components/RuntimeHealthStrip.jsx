import { systemApi } from '../api/system.js';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { buildRuntimeHealth, shouldShowRuntimeHealth } from './runtimeHealth';
import './RuntimeHealthStrip.css';

export default function RuntimeHealthStrip({ backendOnline, navigateTo }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    systemApi.getSystemStatus()
      .then(data => {
        if (!alive) return;
        setStatus(data);
        setError('');
      })
      .catch(err => {
        if (!alive) return;
        setError(err.message || '读取 runtime status 失败');
      });
    return () => { alive = false; };
  }, []);

  const health = useMemo(
    () => buildRuntimeHealth({ status, error, backendOnline }),
    [status, error, backendOnline]
  );

  if (!shouldShowRuntimeHealth(health, backendOnline)) return null;

  return (
    <section className="glass-card runtime-health-alert" role="alert">
      <div className="runtime-health-alert-copy">
        <span className="runtime-health-alert-icon"><AlertTriangle size={18} /></span>
        <div>
          <strong>运行环境需要关注</strong>
          <p>{health.reason}</p>
        </div>
      </div>
      <button className="btn btn-secondary" onClick={() => navigateTo('settings')}>
        查看设置 <ArrowRight size={13} />
      </button>
    </section>
  );
}
