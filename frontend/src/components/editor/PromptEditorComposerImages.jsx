import { X } from 'lucide-react';
import { resolveAttachmentSrc } from './attachments';
import './PromptEditorComposerImages.css';

export default function PromptEditorComposerImages({ attachments = [], onRemove }) {
  if (!attachments.length) return null;

  return (
    <div className="prompt-image-attachment-area" aria-label="已附加图片">
      {attachments.map((attachment, index) => (
        <div className="prompt-image-attachment-card" key={`${attachment.src}-${index}`}>
          <img src={resolveAttachmentSrc(attachment.src)} alt={attachment.alt || 'uploaded image'} />
          <div className="prompt-image-attachment-name" title={attachment.alt}>
            {attachment.alt || 'uploaded image'}
          </div>
          <button
            type="button"
            className="prompt-image-attachment-remove"
            aria-label={`移除图片 ${attachment.alt || index + 1}`}
            onClick={() => onRemove?.(index)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
