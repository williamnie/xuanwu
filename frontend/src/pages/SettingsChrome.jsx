import { systemApi } from '../api/system.js';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Boxes, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { message } from '../store/toastStore';
import { SETTINGS_ADVANCED_TABS, SETTINGS_PRIMARY_TABS } from './settingsNavigation';
import { useI18n } from '../i18n/context.js';

export function SettingsHeader({ onRouteChange, route, title = 'Settings' }) {
  const { t } = useI18n();
  return (
    <header className="settings-header">
      <div className="settings-title-row">
        <div>
          <div className="settings-eyebrow">
            <Boxes size={14} /> {t('settings.eyebrow')}
          </div>
          <h1>{title === 'Settings' ? t('settings.title') : title}</h1>
        </div>
      </div>
      <SettingsNavigation onRouteChange={onRouteChange} route={route} />
    </header>
  );
}

function SettingsNavigation({ onRouteChange, route }) {
  const { t } = useI18n();
  const advanced = route.tier === 'advanced';
  const lastPrimaryTab = useRef(advanced ? 'general' : route.tab);

  useEffect(() => {
    if (!advanced) lastPrimaryTab.current = route.tab;
  }, [advanced, route.tab]);

  const toggleAdvanced = () => {
    onRouteChange(advanced
      ? { tier: 'primary', tab: lastPrimaryTab.current }
      : { tier: 'advanced', tab: 'diagnostics' });
  };

  return (
    <div className="settings-navigation-stack">
      <div className="settings-navigation-row">
        <nav className="settings-tabs" role="tablist" aria-label={t('settings.primarySections')}>
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
          aria-label={advanced ? t('settings.closeAdvanced') : t('settings.openAdvanced')}
          aria-pressed={advanced}
          className={`settings-advanced-gate ${advanced ? 'active' : ''}`}
          onClick={toggleAdvanced}
          type="button"
        >
          <SlidersHorizontal size={15} /> {t('settings.advanced')}
        </button>
      </div>
      {advanced && (
        <div className="settings-advanced-navigation">
          <nav className="settings-tabs settings-advanced-tabs" role="tablist" aria-label={t('settings.advancedSections')}>
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
  const { t } = useI18n();
  return (
    <button
      aria-selected={active}
      className={`settings-tab ${active ? 'active' : ''}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {t(`settings.${tab.id}`)}
    </button>
  );
}

export function RestartAction() {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const handleRestart = async () => restartSystem(setRestarting, setConfirming, t);
  return (
    <div className="settings-restart-zone">
      <button
        className="btn settings-danger-button"
        disabled={restarting}
        onClick={() => setConfirming(true)}
        type="button"
      >
        <RefreshCw size={15} className={restarting ? 'spin-animation' : ''} />
        {restarting ? t('settings.restarting') : t('settings.restartService')}
      </button>
      {confirming && (
        <RestartConfirm restarting={restarting} onCancel={() => setConfirming(false)} onRestart={handleRestart} />
      )}
    </div>
  );
}

function RestartConfirm({ onCancel, onRestart, restarting }) {
  const { t } = useI18n();
  return (
    <div className="settings-restart-confirm" role="alert">
      <div>
        <strong><AlertTriangle size={15} /> {t('settings.confirmRestart')}</strong>
        <p>{t('settings.restartImpact')}</p>
      </div>
      <div className="settings-restart-confirm-actions">
        <button className="btn btn-secondary" disabled={restarting} onClick={onCancel} type="button">{t('settings.cancel')}</button>
        <button className="btn settings-danger-button" disabled={restarting} onClick={onRestart} type="button">
          {t('settings.confirmRestartAction')}
        </button>
      </div>
    </div>
  );
}

async function restartSystem(setRestarting, setConfirming, t) {
  setRestarting(true);
  try {
    await systemApi.restartSystem();
    setConfirming(false);
    message.success(t('settings.restartSent'));
  } catch (err) {
    setRestarting(false);
    message.error(err.message || t('settings.restartFailed'));
  }
}
