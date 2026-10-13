import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import ReleaseUpdatePanel from './ReleaseUpdatePanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import Projects from './Projects';
import ExecutionPresetsPanel from './ExecutionPresetsPanel.jsx';
import RemoteAccessTokenPanel from './RemoteAccessTokenPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import CodeAgentsPanel from './CodeAgentsPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import TelegramSettingsPanel from './TelegramSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import { RestartAction } from './SettingsChrome';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import SettingsDisclosure from '../components/SettingsDisclosure.jsx';
import { settingsSectionCopy } from './settingsNavigation.js';
import { useI18n } from '../i18n/context.js';
import { translate } from '../i18n/translations.js';
import { message } from '../store/toastStore.js';
import { APP_VERSION } from '../version.js';

export default function SettingsTabContent({ activeTab, RuntimeStatusPanel, navigateTo, section, theme, toggleTheme }) {
  const [visited, setVisited] = useState([activeTab]);
  if (!visited.includes(activeTab)) setVisited([...visited, activeTab]);
  const visibleTabs = visited.includes(activeTab) ? visited : [...visited, activeTab];
  return visibleTabs.map(tab => <div key={tab} hidden={activeTab !== tab}>
    {tab === 'general' && <GeneralSettingsTab />}
    {tab === 'ai' && <><CodeAgentsPanel /><SupervisorSettingsTab navigateTo={navigateTo} /></>}
    {tab === 'connections' && <><NotificationsSettingsTab /><IntegrationsSettingsTab /></>}
    {tab === 'preferences' && <><LanguageAndVersionCard /><button className="btn btn-secondary" onClick={toggleTheme} type="button">{theme === 'dark' ? '切换浅色主题' : '切换深色主题'}</button><ReleaseUpdatePanel /></>}
    {tab === 'advanced' && <AdvancedSettingsTab section={section} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />}
  </div>);
}

function SupervisorSettingsTab({ navigateTo }) {
  return <div className="settings-supervisor-page" id="settings-supervisor"><PiAgentSettingsPanel onOpenCodeAgents={() => navigateTo('settings', null, '', '', { settingsSection: 'code-agents' })} /></div>;
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
    <div className="settings-integrations-page" id="settings-integrations">
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
      {visitedChannels.includes('health') && <div className="settings-connection-health" hidden={channel !== 'health'}><ConnectorDiagnosticsPanel /></div>}
    </div>
  );
}

function GeneralSettingsTab() {
  return (
    <>
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
  return <div id="settings-notifications"><NotificationSettingsPanel /></div>;
}

function AdvancedSettingsTab({ section, RuntimeStatusPanel, navigateTo }) {
  const { language } = useI18n();
  const sections = [
    ['diagnostics', <AdvancedDiagnosticsSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />],
    ['permissions', <><PermissionsSettingsTab navigateTo={navigateTo} /><SourcePoliciesPanel /></>],
    ['skills', <><SkillsRuntimePanel /><PiMcpManagementPanel embedded /></>],
    ['memory', <PiMemoryPanel />],
    ['presets', <ExecutionPresetsPanel />],
    ['activity', <ActivityTimelinePanel navigateTo={navigateTo} />],
  ];
  return sections.map(([id, content]) => <SettingsDisclosure id={`settings-${id}`} key={id} selected={section === id} title={settingsSectionCopy(id, language).title}>{content}</SettingsDisclosure>);
}

function AdvancedDiagnosticsSettingsTab({ RuntimeStatusPanel, navigateTo }) {
  const { t } = useI18n();
  return <><RuntimeStatusPanel /><RemoteAccessTokenPanel /><RunnerSettingsPanel /><ConnectorDiagnosticsPanel />
    <button className="btn btn-secondary" onClick={() => navigateTo('runs')} type="button">全部执行记录</button>
    <section className="glass-card settings-advanced-danger-zone"><div><h3>{t('settings.serviceLifecycle')}</h3></div><RestartAction /></section>
  </>;
}
