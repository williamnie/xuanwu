import { X } from 'lucide-react';
import EvidencePanel from '../../components/EvidencePanel.jsx';
import ModalOverlay from '../../components/ModalOverlay.jsx';
import { useI18n } from '../../i18n/context.js';

export default function WorkEvidenceDialog({ onClose, work }) {
  const { t } = useI18n();
  return (
    <ModalOverlay className="work-evidence-overlay" onBackdropMouseDown={onClose}>
      <div aria-labelledby="work-evidence-title" aria-modal="true" className="work-evidence-dialog" role="dialog">
        <header>
          <div>
            <span>{t('board.decisiveFacts')}</span>
            <h2 id="work-evidence-title">{work.title}</h2>
            <p>{t('board.evidenceDescription')}</p>
          </div>
          <button aria-label={t('board.closeEvidence')} onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <EvidencePanel title="Work Evidence" workId={work.id} />
      </div>
    </ModalOverlay>
  );
}
