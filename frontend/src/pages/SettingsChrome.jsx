import { systemApi } from '../api/system.js';
import { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { message } from '../store/toastStore';
import { SETTINGS_NAVIGATION_GROUPS, resolveSettingsRoute, settingsSectionCopy } from './settingsNavigation';
import { useI18n } from '../i18n/context.js';

export function SettingsHeader({ title = 'Settings' }) {
  const { language, t } = useI18n();
  return (
    <header className="settings-header">
      <div className="settings-title-row">
        <div>
          <div className="settings-eyebrow">SETTINGS</div>
          <h1>{title === 'Settings' ? t('settings.title') : title}</h1>
          <p>{language === 'en-US'
            ? 'Set up your projects, assistant, and notifications. Start with the section you need.'
            : '管理项目、助手和通知，从你需要调整的设置开始。'}</p>
        </div>
      </div>
    </header>
  );
}

export function SettingsNavigation({ onRouteChange, route }) {
  const { language } = useI18n();
  const locale = language === 'en-US' ? 'en-US' : 'zh-CN';
  const label = locale === 'en-US' ? 'Settings sections' : '设置目录';
  return (
    <>
      <nav className="settings-directory" aria-label={label}>
        {SETTINGS_NAVIGATION_GROUPS.map((group) => (
          <div className="settings-directory-group" key={group.id}>
            <h2>{group.label[locale]}</h2>
            {group.tabs.map((tab) => {
              const copy = settingsSectionCopy(tab, locale);
              return (
                <button
                  aria-current={route.tab === tab ? 'page' : undefined}
                  className={`settings-directory-link${route.tab === tab ? ' active' : ''}`}
                  key={tab}
                  onClick={() => onRouteChange(resolveSettingsRoute(tab))}
                  type="button"
                >
                  <span>{copy.title}</span>
                  <small>{copy.hint}</small>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <label className="settings-mobile-directory">
        <span>{label}</span>
        <select value={route.tab} onChange={(event) => onRouteChange(resolveSettingsRoute(event.target.value))}>
          {SETTINGS_NAVIGATION_GROUPS.map((group) => (
            <optgroup key={group.id} label={group.label[locale]}>
              {group.tabs.map((tab) => <option key={tab} value={tab}>{settingsSectionCopy(tab, locale).title}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
    </>
  );
}

export function SettingsSectionIntro({ route }) {
  const { language } = useI18n();
  const copy = settingsSectionCopy(route.tab, language);
  return (
    <header className="settings-section-intro">
      <h2 id="settings-section-title">{copy.title}</h2>
      <p>{copy.description}</p>
    </header>
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
