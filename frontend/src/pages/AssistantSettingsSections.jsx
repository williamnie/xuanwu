import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import Projects from './Projects';
import RemoteAccessTokenPanel from './RemoteAccessTokenPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import CodeAgentsPanel from './CodeAgentsPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import ImChannelRegistryPanel from './ImChannelRegistryPanel';
import { RestartAction } from './SettingsChrome';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { translate } from '../i18n/translations.js';
import { message } from '../store/toastStore.js';
import { APP_VERSION } from '../version.js';

export default function SettingsTabContent({ activeTab, RuntimeStatusPanel, navigateTo, tier }) {
  if (tier === 'advanced') {
    return <AdvancedSettingsTab activeTab={activeTab} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />;
  }
  return (
    <>
      {activeTab === 'general' && <GeneralSettingsTab />}
      {activeTab === 'supervisor' && <SupervisorSettingsTab />}
      {activeTab === 'code-agents' && <CodeAgentsPanel />}
      {activeTab === 'integrations' && <IntegrationsSettingsTab />}
      {activeTab === 'permissions' && <PermissionsSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'notifications' && <NotificationsSettingsTab />}
    </>
  );
}

function SupervisorSettingsTab() {
  return (
    <div className="settings-supervisor-page">
      <PiAgentSettingsPanel />
      <section className="glass-card settings-configuration-stage settings-supervisor-tools">
        <SettingsStageHeader
          description="发现并启用 Supervisor 可以调用的工具，分别控制 server、capability 与写入审批。"
          index="03"
          title="工具与 MCP"
        />
        <PiMcpManagementPanel embedded />
      </section>
    </div>
  );
}

function IntegrationsSettingsTab() {
  return (
    <div className="settings-integrations-page">
      <section className="settings-section-intro">
        <div className="settings-entry-eyebrow">External channels</div>
        <h2>Integrations</h2>
        <p>管理飞书、Git、Tracker、Webhook 等外部事件入口、通知出口与同步健康；Supervisor 主动调用的工具在“工具与 MCP”中管理。</p>
      </section>
      <ConnectorDiagnosticsPanel />
      <ImChannelRegistryPanel />
      <FeishuSettingsPanel />
    </div>
  );
}

function SettingsStageHeader({ description, index, title }) {
  return (
    <header className="settings-stage-header">
      <span>{index}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

function GeneralSettingsTab() {
  return (
    <>
      <LanguageAndVersionCard />
      <Projects />
    </>
  );
}

function LanguageAndVersionCard() {
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
    <section className="settings-language-bar" title={t('settings.languageDescription')}>
      <div className="settings-language-label">
        <Languages aria-hidden="true" size={15} />
        <strong>{t('settings.languageTitle')}</strong>
        {saving ? <span>{t('settings.languageSaving')}</span> : null}
      </div>
      <div className="settings-language-options" role="radiogroup" aria-label={t('settings.languageTitle')}>
        <button aria-checked={language === 'zh-CN'} className={language === 'zh-CN' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('zh-CN')} role="radio" type="button">
          {t('settings.chinese')}
        </button>
        <button aria-checked={language === 'en-US'} className={language === 'en-US' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('en-US')} role="radio" type="button">
          {t('settings.english')}
        </button>
      </div>
      <div className="settings-version-inline">
        <span>{t('settings.version')}</span>
        <strong>{APP_VERSION}</strong>
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
      {activeTab === 'diagnostics' && <AdvancedDiagnosticsSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} />}
      {activeTab === 'skills' && <AdvancedSkillsSettingsTab />}
      {activeTab === 'memory' && <MemorySettingsTab />}
      {activeTab === 'activity' && <ActivityTimelinePanel navigateTo={navigateTo} />}
      {activeTab === 'policies' && <SourcePoliciesPanel />}
    </>
  );
}

function AdvancedDiagnosticsSettingsTab({ RuntimeStatusPanel }) {
  const { t } = useI18n();
  return (
    <>
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <div className="settings-entry-eyebrow">{t('settings.advancedDiagnostics')}</div>
          <h2>{t('settings.serviceLifecycle')}</h2>
          <p>{t('settings.restartDescription')}</p>
        </div>
        <RestartAction />
      </section>
      <RuntimeStatusPanel />
      <RemoteAccessTokenPanel />
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
