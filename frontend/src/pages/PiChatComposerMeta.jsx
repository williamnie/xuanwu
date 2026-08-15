import { Brain, Cpu, FolderGit2, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

export default function PiChatComposerMeta({ project, supervisor }) {
  const { t } = useI18n();
  const model = supervisorModelLabel(supervisor);
  return (
    <div className="pi-chat-runtime-controls" aria-label={t('chat.context.label')}>
      <RuntimePill icon={<Sparkles size={13} />} label="π · PI 直连" />
      {model && <RuntimePill icon={<Cpu size={13} />} label={model} />}
      {supervisor?.thinking_level && <RuntimePill icon={<Brain size={13} />} label={thinkingLabel(supervisor.thinking_level)} />}
      {project && (
        <RuntimePill icon={<FolderGit2 size={13} />} label={projectLabel(project)} title={t('chat.context.selectProjectHint')} />
      )}
    </div>
  );
}

function RuntimePill({ icon, label, title }) {
  return (
    <span className="pi-chat-runtime-pill" title={title}>
      {icon}
      {label}
    </span>
  );
}

function projectLabel(project) {
  return `@${project.name || project.id}`;
}

function supervisorModelLabel(supervisor) {
  const provider = String(supervisor?.model_provider || '').trim();
  const model = String(supervisor?.model_id || '').trim();
  return [provider, model].filter(Boolean).join(' · ');
}

function thinkingLabel(value) {
  return ({ minimal: 'Min', low: '低', medium: '中', high: '高', xhigh: '超高' })[value] || value;
}
