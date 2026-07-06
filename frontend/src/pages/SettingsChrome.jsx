import { useState } from 'react';
import { AlertTriangle, Boxes, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { message } from '../store/toastStore';

const SETTINGS_TABS = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'runner-brain', label: 'Runtime' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'skills', label: 'Skills' },
  { id: 'automations', label: 'Automations' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'memory', label: 'Memory' },
  { id: 'activity', label: 'Activity' },
];

export function SettingsHeader({ activeTab, onTabChange }) {
  return (
    <header className="settings-header">
      <div className="settings-title-row">
        <div>
          <div className="settings-eyebrow">
            <Boxes size={14} /> PI Assistant · Single Runtime
          </div>
          <h1>Assistant Settings</h1>
        </div>
        <RestartAction />
      </div>
      <SettingsTabs activeTab={activeTab} onTabChange={onTabChange} />
    </header>
  );
}

function SettingsTabs({ activeTab, onTabChange }) {
  return (
    <nav className="settings-tabs" role="tablist" aria-label="Assistant Settings sections">
      {SETTINGS_TABS.map((tab) => (
        <TabButton key={tab.id} active={activeTab === tab.id} onClick={() => onTabChange(tab.id)} tab={tab} />
      ))}
    </nav>
  );
}

function TabButton({ active, onClick, tab }) {
  return (
    <button
      aria-selected={active}
      className={`settings-tab ${active ? 'active' : ''}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {tab.label}
    </button>
  );
}

function RestartAction() {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const handleRestart = async () => restartSystem(setRestarting, setConfirming);
  return (
    <div className="settings-restart-zone">
      <button
        className="btn settings-danger-button"
        disabled={restarting}
        onClick={() => setConfirming(true)}
        type="button"
      >
        <RefreshCw size={15} className={restarting ? 'spin-animation' : ''} />
        {restarting ? '重启中...' : '重启服务'}
      </button>
      {confirming && (
        <RestartConfirm restarting={restarting} onCancel={() => setConfirming(false)} onRestart={handleRestart} />
      )}
    </div>
  );
}

function RestartConfirm({ onCancel, onRestart, restarting }) {
  return (
    <div className="settings-restart-confirm" role="alert">
      <div>
        <strong><AlertTriangle size={15} /> 确认重启 Xuanwu？</strong>
        <p>服务会短暂断开，随后由守护进程拉起。</p>
      </div>
      <div className="settings-restart-confirm-actions">
        <button className="btn btn-secondary" disabled={restarting} onClick={onCancel} type="button">取消</button>
        <button className="btn settings-danger-button" disabled={restarting} onClick={onRestart} type="button">
          确认重启
        </button>
      </div>
    </div>
  );
}

async function restartSystem(setRestarting, setConfirming) {
  setRestarting(true);
  try {
    await api.restartSystem();
    setConfirming(false);
    message.success('重启请求已发送，服务会短暂断开。');
  } catch (err) {
    setRestarting(false);
    message.error(err.message || '重启失败');
  }
}
