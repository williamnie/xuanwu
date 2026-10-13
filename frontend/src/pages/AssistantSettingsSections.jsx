import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import ReleaseUpdatePanel from './ReleaseUpdatePanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import Projects from './Projects';
import ExecutionPresetsPanel from './ExecutionPresetsPanel';
import RemoteAccessTokenPanel from './RemoteAccessTokenPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PersonaSettingsPanel from './PersonaSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import CodeAgentsPanel from './CodeAgentsPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import TelegramSettingsPanel from './TelegramSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import ImChannelRegistryPanel from './ImChannelRegistryPanel';
import { RestartAction } from './SettingsChrome';
import { SETTINGS_ADVANCED_SECTIONS, advancedSectionCopy } from './settingsNavigation';
import { Languages, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { translate } from '../i18n/translations.js';
import { message } from '../store/toastStore.js';
import { APP_VERSION } from '../version.js';

export default function SettingsTabContent({ activeTab, advancedSection, navigateTo, onAdvancedSectionChange, RuntimeStatusPanel, theme, toggleTheme }) {
  return (
    <>
      {activeTab === 'general' && <Projects />}
      {activeTab === 'ai' && <AiConnectionsTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'preferences' && <PreferencesTab theme={theme} toggleTheme={toggleTheme} />}
      {activeTab === 'advanced' && (
        <AdvancedSettingsTab
          navigateTo={navigateTo}
          onSectionChange={onAdvancedSectionChange}
          RuntimeStatusPanel={RuntimeStatusPanel}
          section={advancedSection}
        />
      )}
    </>
  );
}

// 编程工具与玄武助手合并为一个分区；表达风格已移到“通用”，由独立面板单独保存。
function AiConnectionsTab() {
  return (
    <div className="settings-ai-page">
      <CodeAgentsPanel />
      <PiAgentSettingsPanel />
    </div>
  );
}

function NotificationsTab() {
  const { language } = useI18n();
  return (
    <div className="settings-notifications-page">
      <NotificationSettingsPanel />
      <h3 className="settings-subsection-title">{language === 'en-US' ? 'External connections' : '外部连接'}</h3>
      <IntegrationsSettingsTab />
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

function PreferencesTab({ theme, toggleTheme }) {
  return (
    <div className="settings-preferences">
      <LanguageCard />
      <ThemeCard theme={theme} toggleTheme={toggleTheme} />
      <PersonaSettingsPanel />
      <ReleaseUpdatePanel />
    </div>
  );
}

function LanguageCard() {
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

// 与侧栏底部的切换按钮是同一个开关，这里只是便于查找。
function ThemeCard({ theme, toggleTheme }) {
  const { language, t } = useI18n();
  const english = language === 'en-US';
  return (
    <section className="settings-language-bar">
      <div className="settings-language-label">
        {theme === 'dark' ? <Moon aria-hidden="true" size={15} /> : <Sun aria-hidden="true" size={15} />}
        <div>
          <strong>{english ? 'Theme' : '主题'}</strong>
          <p>{english ? 'Same switch as the one at the bottom of the sidebar.' : '与侧栏底部的切换按钮相同。'}</p>
        </div>
      </div>
      <div className="settings-language-options" role="group" aria-label={english ? 'Theme' : '主题'}>
        <button aria-pressed={theme !== 'dark'} className={theme !== 'dark' ? 'active' : ''} disabled={!toggleTheme} onClick={() => theme === 'dark' && toggleTheme?.()} type="button">
          {t('sidebar.lightTheme')}
        </button>
        <button aria-pressed={theme === 'dark'} className={theme === 'dark' ? 'active' : ''} disabled={!toggleTheme} onClick={() => theme !== 'dark' && toggleTheme?.()} type="button">
          {t('sidebar.darkTheme')}
        </button>
      </div>
    </section>
  );
}

// “高级”是一个页面：各节默认折叠，首次展开才挂载（很多面板挂载即发请求）；
// 展开过的节收起后保留挂载，草稿不丢；深链只展开并定位目标节。
function AdvancedSettingsTab({ navigateTo, onSectionChange, RuntimeStatusPanel, section }) {
  const { language } = useI18n();
  const [visited, setVisited] = useState(() => new Set(section ? [section] : []));
  const sectionRefs = useRef({});

  useEffect(() => {
    if (!section) return;
    setVisited(current => current.has(section) ? current : new Set([...current, section]));
    const element = sectionRefs.current[section];
    if (element) {
      element.open = true;
      element.scrollIntoView?.({ block: 'start' });
    }
  }, [section]);

  const content = {
    diagnostics: <AdvancedDiagnostics RuntimeStatusPanel={RuntimeStatusPanel} />,
    security: <><PermissionsSettingsPanel navigateTo={navigateTo} /><SourcePoliciesPanel /></>,
    skills: <><SkillsRuntimePanel /><PiMcpManagementPanel embedded /></>,
    memory: <PiMemoryPanel />,
    presets: <ExecutionPresetsPanel />,
    activity: <ActivityTimelinePanel navigateTo={navigateTo} />,
  };

  return (
    <div className="settings-advanced-sections">
      {SETTINGS_ADVANCED_SECTIONS.map(({ id }) => {
        const copy = advancedSectionCopy(id, language);
        return (
          <details
            className="settings-disclosure"
            id={`settings-advanced-${id}`}
            key={id}
            onToggle={(event) => {
              if (!event.currentTarget.open) return;
              setVisited(current => current.has(id) ? current : new Set([...current, id]));
              if (id !== section) onSectionChange?.(id);
            }}
            ref={element => { sectionRefs.current[id] = element; }}
          >
            <summary><strong>{copy.title}</strong><span>{copy.hint}</span></summary>
            {visited.has(id) ? <div className="settings-disclosure-content settings-advanced-body">{content[id]}</div> : null}
          </details>
        );
      })}
    </div>
  );
}

function AdvancedDiagnostics({ RuntimeStatusPanel }) {
  const { t } = useI18n();
  return (
    <>
      <RuntimeStatusPanel />
      <RunnerSettingsPanel />
      <RemoteAccessTokenPanel />
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <h2>{t('settings.serviceLifecycle')}</h2>
          <p>{t('settings.restartDescription')}</p>
        </div>
        <RestartAction />
      </section>
    </>
  );
}
