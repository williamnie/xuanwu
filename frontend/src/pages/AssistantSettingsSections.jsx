import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import { RestartAction } from './SettingsChrome';

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
  return (
    <section className="glass-card settings-project-entry">
      <div>
        <div className="settings-entry-eyebrow">Per-project settings</div>
        <h2>项目设置</h2>
        <p>打开 Projects 编辑现有项目；这里不复制项目表单，也不会产生双写。</p>
      </div>
      <button className="btn btn-secondary" onClick={() => navigateTo?.('projects')} type="button">
        管理项目设置
      </button>
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
  return (
    <>
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <div className="settings-entry-eyebrow">Advanced runtime</div>
          <h2>服务生命周期</h2>
          <p>重启会短暂中断当前服务，仅在确认后发送现有受审计的 restart 请求。</p>
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
