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
import AutomationsRuntimePanel from './AutomationsRuntimePanel';
import { AssistantOverviewPanel, SettingsPlaceholderPanel } from './AssistantSettingsPlaceholders';

export default function SettingsTabContent({ activeTab, RuntimeStatusPanel, navigateTo }) {
  return (
    <>
      {activeTab === 'assistant' && <AssistantSettingsTab />}
      {activeTab === 'runner-brain' && <RunnerBrainSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} />}
      {activeTab === 'connectors' && <ConnectorsSettingsTab />}
      {activeTab === 'skills' && <SkillsSettingsTab />}
      {activeTab === 'automations' && <AutomationsRuntimePanel />}
      {activeTab === 'approvals' && <ApprovalsPlaceholder />}
      {activeTab === 'memory' && <MemorySettingsTab />}
      {activeTab === 'activity' && <ActivityTimelinePanel navigateTo={navigateTo} />}
      {activeTab === 'policies' && <SourcePoliciesPanel />}
    </>
  );
}

function AssistantSettingsTab() {
  return (
    <>
      <AssistantOverviewPanel />
      <PiAgentSettingsPanel />
    </>
  );
}

function RunnerBrainSettingsTab({ RuntimeStatusPanel }) {
  return (
    <>
      <RuntimeStatusPanel />
      <RunnerSettingsPanel />
      <ProviderAvailabilityPanel />
    </>
  );
}

function ConnectorsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Connectors"
        title="Connector slots"
        description="外部来源会作为 Supervisor 的 connector/tool provider 接入；当前提供只读健康摘要和已有 IM 配置入口。"
        items={['CLI connector 通过 manifest 暴露配置/health 诊断。', 'Feishu 仍走现有 integration settings API。']}
      />
      <PiMcpManagementPanel />
      <ConnectorDiagnosticsPanel />
      <FeishuSettingsPanel />
    </>
  );
}

function SkillsSettingsTab() {
  return (
    <>
      <SettingsPlaceholderPanel
        eyebrow="Skills"
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

function ApprovalsPlaceholder() {
  return <SettingsPlaceholderPanel eyebrow="Approvals" title="Approval policy" description="预留 action proposal 审批与外部写操作权限入口；默认不引入新的自动外部写操作。" />;
}
