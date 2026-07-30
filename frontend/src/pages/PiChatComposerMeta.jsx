import { Brain, Cpu, FolderGit2 } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

export default function PiChatComposerMeta({ advanced = false, agent, project }) {
  const { t } = useI18n();
  if (!project && !advanced) return null;
  return (
    <div className="pi-chat-runtime-controls" aria-label={t('chat.context.label')}>
      {project && <RuntimePill icon={<FolderGit2 size={13} />} label={projectLabel(project)} title={t('chat.context.selectProjectHint')} />}
      {advanced && (
        <>
          <RuntimePill icon={<Cpu size={13} />} label={agentModelLabel(agent, t)} muted={!agent} title={t('chat.context.modelHint')} />
          <RuntimePill icon={<Brain size={13} />} label={thinkingLabel(agent, t)} muted={!agent?.thinking_level} title={t('chat.context.thinkingHint')} />
        </>
      )}
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
  return `@${project.name || project.id}`;
}

function agentModelLabel(agent, t) {
  if (!agent) return t('chat.context.notConfigured');
  const provider = agent.model_provider || t('chat.context.providerUnset');
  const model = agent.model_id || t('chat.context.modelUnset');
  return `${provider} / ${model}`;
}

function thinkingLabel(agent, t) {
  return agent?.thinking_level || t('chat.context.default');
}
