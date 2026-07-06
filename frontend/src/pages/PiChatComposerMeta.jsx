import { Brain, Cpu, FolderGit2 } from 'lucide-react';

export default function PiChatComposerMeta({ agent, project }) {
  return (
    <div className="pi-chat-runtime-controls" aria-label="PI runtime context">
      <RuntimePill icon={<FolderGit2 size={13} />} label={projectLabel(project)} muted={!project} title="输入 @ 选择 PI 工作项目" />
      <RuntimePill icon={<Cpu size={13} />} label={agentModelLabel(agent)} muted={!agent} title="PI Assistant 当前模型；如需修改请到 Assistant Settings" />
      <RuntimePill icon={<Brain size={13} />} label={thinkingLabel(agent)} muted={!agent?.thinking_level} title="PI Assistant thinking level" />
    </div>
  );
}

function RuntimePill({ icon, label, muted, title }) {
  return (
    <span className={`pi-chat-runtime-pill ${muted ? 'muted' : ''}`} title={title}>
      {icon}
      {label}
    </span>
  );
}

function projectLabel(project) {
  if (!project) return '@ 选择项目';
  return `@${project.name || project.id}`;
}

function agentModelLabel(agent) {
  if (!agent) return 'PI 未配置';
  const provider = agent.model_provider || 'provider 未设';
  const model = agent.model_id || 'model 未设';
  return `${provider} / ${model}`;
}

function thinkingLabel(agent) {
  return agent?.thinking_level || '默认';
}
