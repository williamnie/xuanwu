import IssueTemplatesPanel from './IssueTemplatesPanel';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMemoryPanel from './PiMemoryPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import { SettingsPlaceholderPanel } from './AssistantSettingsPlaceholders';
import { RestartAction } from './SettingsChrome';

export default function SettingsTabContent({ activeTab, RuntimeStatusPanel, navigateTo, tier }) {
  if (tier === 'advanced') {
    return <AdvancedSettingsTab activeTab={activeTab} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />;
  }
  return (
    <>
      {activeTab === 'general' && <GeneralSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'models-agents' && <ModelsAgentsSettingsTab />}
      {activeTab === 'connections' && <ConnectionsSettingsTab />}
      {activeTab === 'permissions' && <PermissionsSettingsTab />}
      {activeTab === 'notifications' && <NotificationsSettingsTab />}
    </>
  );
}

function GeneralSettingsTab({ navigateTo }) {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="General"
        title="玄武工作方式"
        description="Settings 只组织现有配置入口；项目、Supervisor 与 Runner 继续使用现有后端和持久化数据作为唯一 source of truth。"
        items={['普通设置面向日常配置，不展示内部诊断、日志或底层连接参数。', '每个项目的模型、权限与自动执行参数继续在 Projects 中维护。']}
      />
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
    </>
  );
}

function ModelsAgentsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Models & Agents"
        title="默认 Supervisor"
        description="管理日常使用的模型与 Supervisor 状态。底层连接参数与运行诊断只在 Advanced 中显示。"
      />
      <PiAgentSettingsPanel />
    </>
  );
}

function ConnectionsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Connections"
        title="已连接服务"
        description="统一查看连接健康、权限、最近同步、退避与凭据引用；MCP discovery 细节仍保留在 Advanced。"
        items={['测试连接只执行只读 probe 并写入审计。', '撤销只接受当前 connector 声明的 secret ref，不提供明文读取。']}
      />
      <ConnectorDiagnosticsPanel />
      <FeishuSettingsPanel />
    </>
  );
}

function PermissionsSettingsTab() {
  return (
    <SettingsPlaceholderPanel
      eyebrow="Permissions"
      title="权限与审批"
      description="日常权限入口保留确定性审批边界；待处理 Approval 已统一放在 Command Center。"
      items={['LLM 输出不会直接授予工具或外部写权限。', '权限矩阵继续复用现有 approval 与 policy 能力，不在 Settings 复制审批队列。']}
    />
  );
}

function NotificationsSettingsTab() {
  return (
    <SettingsPlaceholderPanel
      eyebrow="Notifications"
      title="通知偏好"
      description="通知设置保留为普通用户入口；P07.13 将在这里接入现有通知偏好与连接状态，不新增并行通知存储。"
    />
  );
}

function AdvancedSettingsTab({ activeTab, RuntimeStatusPanel, navigateTo }) {
  return (
    <>
      {activeTab === 'runtime' && <AdvancedRuntimeSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} />}
      {activeTab === 'model-runtime' && <PiAgentSettingsPanel advanced />}
      {activeTab === 'mcp' && <AdvancedConnectionsSettingsTab />}
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

function AdvancedConnectionsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Advanced · MCP"
        title="Connector runtime"
        description="查看 MCP discovery、capability 与 connector diagnostics；这些内部细节不出现在普通 Connections 路径。"
      />
      <PiMcpManagementPanel />
      <ConnectorDiagnosticsPanel />
    </>
  );
}

function AdvancedSkillsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Advanced · Skills"
        title="Skill registry"
        description="Skills 在同一个 Supervisor 下声明 intake/domain 能力、所需工具、schema 与运行历史。"
        items={['Intake skill 负责从 context bundle 识别入箱事项。', 'Domain skill 负责从 inbox item 生成 approval-gated action proposal。']}
      />
      <SkillsRuntimePanel />
      <IssueTemplatesPanel />
    </>
  );
}

function MemorySettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Memory"
        title="Supervisor Memory"
        description="Memory 是 Supervisor 的可审计上下文入口；当前继续使用已有 memory 面板。"
      />
      <PiMemoryPanel />
    </>
  );
}
