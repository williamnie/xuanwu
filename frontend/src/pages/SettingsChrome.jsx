import { systemApi } from '../api/system.js';
import { useState } from 'react';
import { AlertTriangle, Boxes, ChevronLeft, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { message } from '../store/toastStore';
import { SETTINGS_ADVANCED_TABS, SETTINGS_PRIMARY_TABS } from './settingsNavigation';

export function SettingsHeader({ onRouteChange, route, title = 'Settings' }) {
  return (
    <header className="settings-header">
      <div className="settings-title-row">
        <div>
          <div className="settings-eyebrow">
            <Boxes size={14} /> Xuanwu · Product Settings
          </div>
          <h1>{title}</h1>
        </div>
      </div>
      <SettingsNavigation onRouteChange={onRouteChange} route={route} />
    </header>
  );
}

function SettingsNavigation({ onRouteChange, route }) {
  const advanced = route.tier === 'advanced';
  return (
    <div className="settings-navigation-stack">
      <div className="settings-navigation-row">
        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_PRIMARY_TABS.map((tab) => (
            <TabButton
              key={tab.id}
              active={!advanced && route.tab === tab.id}
              onClick={() => onRouteChange({ tier: 'primary', tab: tab.id })}
              tab={tab}
            />
          ))}
        </nav>
        <button
          aria-pressed={advanced}
          className={`settings-advanced-gate ${advanced ? 'active' : ''}`}
          onClick={() => onRouteChange({ tier: 'advanced', tab: 'runtime' })}
          type="button"
        >
          <SlidersHorizontal size={15} /> Advanced
        </button>
      </div>
      {advanced && (
        <div className="settings-advanced-navigation">
          <button
            className="settings-advanced-back"
            onClick={() => onRouteChange({ tier: 'primary', tab: 'general' })}
            type="button"
          >
            <ChevronLeft size={15} /> 普通设置
          </button>
          <nav className="settings-tabs settings-advanced-tabs" role="tablist" aria-label="Advanced Settings sections">
            {SETTINGS_ADVANCED_TABS.map((tab) => (
              <TabButton
                key={tab.id}
                active={route.tab === tab.id}
                onClick={() => onRouteChange({ tier: 'advanced', tab: tab.id })}
                tab={tab}
              />
            ))}
          </nav>
        </div>
      )}
    </div>
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

export function RestartAction() {
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
        <strong><AlertTriangle size={15} /> 确认重启玄武？</strong>
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
    await systemApi.restartSystem();
    setConfirming(false);
    message.success('重启请求已发送，服务会短暂断开。');
  } catch (err) {
    setRestarting(false);
    message.error(err.message || '重启失败');
  }
}
