import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import CronTasksPanel from '../components/CronTasksPanel';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import IssueTemplatesPanel from './IssueTemplatesPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';

export default function Settings() {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      <div style={{ flexShrink: 0, padding: '24px 0 8px 0' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>系统设置</h1>
        <p style={{ color: 'var(--text-muted)' }}>管理全局执行配置与 Codex Issue Runner 行为。</p>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' }}>
        <RestartPanel />
        <NotificationSettingsPanel />
        <CronTasksPanel />
        <IssueTemplatesPanel />
      </div>
    </div>
  );
}

function RestartPanel() {
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!window.confirm('确定重启 Codex Issue Runner？服务会短暂断开。')) return;
    setRestarting(true);
    try {
      await api.restartSystem();
      message.success('重启请求已发送，服务会短暂断开。');
    } catch (err) {
      setRestarting(false);
      message.error(err.message || '重启失败');
    }
  };

  return (
    <section className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={18} color="var(--primary)" /> 服务重启
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          发送重启请求后，页面会短暂断开；由 launchd 等守护进程拉起新服务。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={handleRestart} disabled={restarting}>
        <RefreshCw size={15} className={restarting ? 'spin-animation' : ''} />
        {restarting ? '重启中...' : '重启服务'}
      </button>
    </section>
  );
}
