import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import { RestartAction } from './SettingsChrome';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { translate } from '../i18n/translations.js';
import { message } from '../store/toastStore.js';

export default function SettingsTabContent({ activeTab, RuntimeStatusPanel, navigateTo, tier }) {
  if (tier === 'advanced') {
    return <AdvancedSettingsTab activeTab={activeTab} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />;
  }
  return (
    <>
      {activeTab === 'general' && <GeneralSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'permissions' && <PermissionsSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'notifications' && <NotificationsSettingsTab />}
    </>
  );
}

function GeneralSettingsTab({ navigateTo }) {
  const { t } = useI18n();
  return (
    <>
      <LanguageSettingsCard />
      <section className="glass-card settings-project-entry">
        <div>
          <div className="settings-entry-eyebrow">{t('settings.perProject')}</div>
          <h2>{t('settings.projectSettings')}</h2>
          <p>{t('settings.projectSettingsDescription')}</p>
        </div>
        <button className="btn btn-secondary" onClick={() => navigateTo?.('projects')} type="button">
          {t('settings.manageProjects')}
        </button>
      </section>
    </>
  );
}

function LanguageSettingsCard() {
  const { changeLanguage, language, t } = useI18n();
  const [saving, setSaving] = useState(false);
  const selectLanguage = async (next) => {
    if (saving || next === language) return;
    setSaving(true);
    try {
      await changeLanguage(next);
      message.success(translate(next, 'settings.languageSaved'));
    } catch (error) {
      message.error(error?.message || t('settings.languageSaveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="glass-card settings-language-card">
      <div className="settings-language-copy">
        <div className="settings-entry-eyebrow"><Languages size={14} /> i18n</div>
        <h2>{t('settings.languageTitle')}</h2>
        <p>{t('settings.languageDescription')}</p>
        {saving ? <span>{t('settings.languageSaving')}</span> : null}
      </div>
      <div className="settings-language-options" role="radiogroup" aria-label={t('settings.languageTitle')}>
        <button aria-checked={language === 'zh-CN'} className={language === 'zh-CN' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('zh-CN')} role="radio" type="button">
          <strong>{t('settings.chinese')}</strong><span>zh-CN</span>
        </button>
        <button aria-checked={language === 'en-US'} className={language === 'en-US' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('en-US')} role="radio" type="button">
          <strong>{t('settings.english')}</strong><span>en-US</span>
        </button>
      </div>
    </section>
  );
}

function PermissionsSettingsTab({ navigateTo }) {
  return <PermissionsSettingsPanel navigateTo={navigateTo} />;
}

function NotificationsSettingsTab() {
  return <NotificationSettingsPanel />;
}

function AdvancedSettingsTab({ activeTab, RuntimeStatusPanel, navigateTo }) {
  return (
    <>
      {activeTab === 'runtime' && <AdvancedRuntimeSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} />}
      {activeTab === 'skills' && <AdvancedSkillsSettingsTab />}
      {activeTab === 'memory' && <MemorySettingsTab />}
      {activeTab === 'activity' && <ActivityTimelinePanel navigateTo={navigateTo} />}
      {activeTab === 'policies' && <SourcePoliciesPanel />}
    </>
  );
}

function AdvancedRuntimeSettingsTab({ RuntimeStatusPanel }) {
  const { t } = useI18n();
  return (
    <>
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <div className="settings-entry-eyebrow">{t('settings.advancedRuntime')}</div>
          <h2>{t('settings.serviceLifecycle')}</h2>
          <p>{t('settings.restartDescription')}</p>
        </div>
        <RestartAction />
      </section>
      <RuntimeStatusPanel />
      <RunnerSettingsPanel />
      <ProviderAvailabilityPanel />
    </>
  );
}

function AdvancedSkillsSettingsTab() {
  return <SkillsRuntimePanel />;
}

function MemorySettingsTab() {
  return <PiMemoryPanel />;
}
