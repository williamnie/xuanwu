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
import RemoteNodesPanel from './RemoteNodesPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PersonaSettingsPanel from './PersonaSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import CodeAgentsPanel from './CodeAgentsPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import TelegramSettingsPanel from './TelegramSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import IntegrationConnectionList from './IntegrationConnectionList';
import IntegrationSettingsDrawer from './IntegrationSettingsDrawer';
import { integrationChannelFromHash, loadConnectionStatus } from './integrationConnections.js';
import { connectorsApi } from '../api/connectors.js';
import { RestartAction } from './SettingsChrome';
import { SETTINGS_ADVANCED_SECTIONS, advancedSectionCopy } from './settingsNavigation';
import { Languages, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { translate } from '../i18n/translations.js';
import { message } from '../store/toastStore.js';
import { APP_VERSION } from '../version.js';

export default function SettingsTabContent({ activeTab, advancedSection, navigateTo, onAdvancedSectionChange, RuntimeStatusPanel, theme, toggleTheme }) {
  return (
    <>
      {activeTab === 'general' && <Projects />}
      {activeTab === 'general' && <RemoteNodesPanel />}
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
  const [channel, setChannel] = useState(() => integrationChannelFromHash(globalThis.location?.hash));
  const [visitedChannels, setVisitedChannels] = useState(() => channel ? [channel] : []);
  const [connectors, setConnectors] = useState([]);
  const [channels, setChannels] = useState([]);
  const english = language === 'en-US';
  useEffect(() => {
    const syncChannel = () => setChannel(integrationChannelFromHash(globalThis.location?.hash));
    window.addEventListener('hashchange', syncChannel);
    window.addEventListener('popstate', syncChannel);
    return () => {
      window.removeEventListener('hashchange', syncChannel);
      window.removeEventListener('popstate', syncChannel);
    };
  }, []);
  useEffect(() => {
    if (channel) setVisitedChannels(visited => visited.includes(channel) ? visited : [...visited, channel]);
    let active = true;
    loadConnectionStatus(connectorsApi, data => active && setConnectors(data), data => active && setChannels(data));
    return () => { active = false; };
  }, [channel]);
  const selectChannel = useCallback(nextChannel => {
    setChannel(nextChannel);
    const url = new URL(window.location.href);
    const [path, query] = url.hash.split('?');
    const params = new URLSearchParams(query);
    if (nextChannel) params.set('channel', nextChannel);
    else params.delete('channel');
    url.hash = `${path}?${params}`;
    window.history.replaceState(null, '', url);
  }, []);
  const closeDrawer = useCallback(() => selectChannel(''), [selectChannel]);
  const title = channel === 'feishu' ? (english ? 'Feishu' : '飞书') : channel === 'telegram' ? 'Telegram' : 'GitHub';
  return (
    <div className="settings-integrations-page">
      <IntegrationConnectionList channels={channels} connectors={connectors} onConfigure={selectChannel} />
      <a href="#/settings?section=advanced:diagnostics">{english ? 'Full diagnostics in Advanced → Maintenance' : '完整诊断：高级 → 运行维护'}</a>
      <IntegrationSettingsDrawer onClose={closeDrawer} open={Boolean(channel)} title={title}>
        {visitedChannels.includes('github') && <div hidden={channel !== 'github'}><GitHubSettingsPanel /></div>}
        {visitedChannels.includes('feishu') && <div hidden={channel !== 'feishu'}><FeishuSettingsPanel /></div>}
        {visitedChannels.includes('telegram') && <div hidden={channel !== 'telegram'}><TelegramSettingsPanel /></div>}
      </IntegrationSettingsDrawer>
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
      <ConnectorDiagnosticsPanel />
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
