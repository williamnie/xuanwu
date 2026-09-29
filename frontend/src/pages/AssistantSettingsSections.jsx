import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import ReleaseUpdatePanel from './ReleaseUpdatePanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import Projects from './Projects';
import RemoteAccessTokenPanel from './RemoteAccessTokenPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import CodeAgentsPanel from './CodeAgentsPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import TelegramSettingsPanel from './TelegramSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
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
      {activeTab === 'supervisor' && <SupervisorSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'code-agents' && <CodeAgentsPanel />}
      {activeTab === 'integrations' && <IntegrationsSettingsTab />}
      {activeTab === 'permissions' && <PermissionsSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'notifications' && <NotificationsSettingsTab />}
    </>
  );
}

function SupervisorSettingsTab({ navigateTo }) {
  const { language } = useI18n();
  const [toolsVisited, setToolsVisited] = useState(false);
  const english = language === 'en-US';
  return (
    <div className="settings-supervisor-page">
      <PiAgentSettingsPanel onOpenCodeAgents={() => navigateTo('settings', null, '', '', { settingsSection: 'code-agents' })} />
      <details className="settings-disclosure" onToggle={(event) => { if (event.currentTarget.open) setToolsVisited(true); }}>
        <summary>
          <strong>{english ? 'Tools & MCP' : '工具与 MCP'}</strong>
          <span>{english ? 'Connect external tools when your assistant needs them.' : '需要让助手调用外部工具时，再展开配置。'}</span>
        </summary>
        {toolsVisited && <div className="settings-disclosure-content"><PiMcpManagementPanel embedded /></div>}
      </details>
    </div>
  );
}

function IntegrationsSettingsTab() {
  const { language } = useI18n();
  const [channel, setChannel] = useState('github');
  const [visitedChannels, setVisitedChannels] = useState(['github']);
  const english = language === 'en-US';
  const selectChannel = (nextChannel) => {
    setChannel(nextChannel);
    setVisitedChannels((visited) => visited.includes(nextChannel) ? visited : [...visited, nextChannel]);
  };
  const channels = [
    ['github', 'GitHub', english ? 'Repositories and issues' : '代码仓库与议题'],
    ['feishu', english ? 'Feishu' : '飞书', english ? 'Messages and notifications' : '消息与通知'],
    ['telegram', 'Telegram', english ? 'Messages and notifications' : '消息与通知'],
    ['health', english ? 'Connection health' : '连接检查', english ? 'Status and troubleshooting' : '查看状态与排查问题'],
  ];
  return (
    <div className="settings-integrations-page">
      <div className="settings-channel-navigation" aria-label={english ? 'Choose a platform' : '选择连接平台'} role="group">
        {channels.map(([id, title, description]) => (
          <button aria-pressed={channel === id} className={channel === id ? 'active' : ''} key={id} onClick={() => selectChannel(id)} type="button">
            <strong>{title}</strong><span>{description}</span>
          </button>
        ))}
      </div>
      {visitedChannels.includes('github') && <div hidden={channel !== 'github'}><GitHubSettingsPanel /></div>}
      {visitedChannels.includes('feishu') && <div hidden={channel !== 'feishu'}><FeishuSettingsPanel /></div>}
      {visitedChannels.includes('telegram') && <div hidden={channel !== 'telegram'}><TelegramSettingsPanel /></div>}
      {visitedChannels.includes('health') && <div className="settings-connection-health" hidden={channel !== 'health'}><ConnectorDiagnosticsPanel /><ImChannelRegistryPanel /></div>}
    </div>
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
        <div>
          <strong>{t('settings.languageTitle')}</strong>
          <p>{language === 'en-US' ? 'Applies to the interface and future replies from Xuanwu.' : '同时用于界面和玄武后续回答。'}</p>
        </div>
        {saving ? <span>{t('settings.languageSaving')}</span> : null}
      </div>
      <div className="settings-language-options" role="group" aria-label={t('settings.languageTitle')}>
        <button aria-pressed={language === 'zh-CN'} className={language === 'zh-CN' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('zh-CN')} type="button">
          {t('settings.chinese')}
        </button>
        <button aria-pressed={language === 'en-US'} className={language === 'en-US' ? 'active' : ''} disabled={saving} onClick={() => selectLanguage('en-US')} type="button">
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
      <ReleaseUpdatePanel />
      <RuntimeStatusPanel />
      <RemoteAccessTokenPanel />
      <RunnerSettingsPanel />
      <ProviderAvailabilityPanel />
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <div className="settings-entry-eyebrow">{t('settings.advancedDiagnostics')}</div>
          <h2>{t('settings.serviceLifecycle')}</h2>
          <p>{t('settings.restartDescription')}</p>
        </div>
        <RestartAction />
      </section>
    </>
  );
}

function AdvancedSkillsSettingsTab() {
  return <SkillsRuntimePanel />;
}

function MemorySettingsTab() {
  return <PiMemoryPanel />;
}
