import { FolderGit2 } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

export default function PiChatComposerMeta({ project }) {
  const { t } = useI18n();
  if (!project) return null;
  return (
    <div className="pi-chat-runtime-controls" aria-label={t('chat.context.label')}>
      <RuntimePill icon={<FolderGit2 size={13} />} label={projectLabel(project)} title={t('chat.context.selectProjectHint')} />
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
