import { useEffect, useState } from 'react';
import { ImageOff, LoaderCircle, X } from 'lucide-react';
import { authHeader } from '../../api/authToken.js';
import { resolveAttachmentSrc } from './attachments';
import './PromptEditorComposerImages.css';

export default function PromptEditorComposerImages({ attachments = [], onRemove }) {
  if (!attachments.length) return null;

  return (
    <div className="prompt-image-attachment-area" aria-label="已附加图片">
      {attachments.map((attachment, index) => (
        <div className="prompt-image-attachment-card" key={`${attachment.src}-${index}`}>
          <AttachmentPreview attachment={attachment} />
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

function AttachmentPreview({ attachment }) {
  const { error, previewSrc } = useAuthenticatedPreview(attachment.src);
  if (error) {
    return <div className="prompt-image-attachment-state error" title={error}><ImageOff size={18} /><span>预览失败</span></div>;
  }
  if (!previewSrc) {
    return <div className="prompt-image-attachment-state loading"><LoaderCircle className="animate-spin" size={18} /><span>读取中</span></div>;
  }
  return <img src={previewSrc} alt="" />;
}

function useAuthenticatedPreview(source) {
  const resolved = resolveAttachmentSrc(source);
  const [state, setState] = useState(() => ({ error: '', previewSrc: isProtectedPreview(resolved) ? '' : resolved }));

  useEffect(() => {
    if (!isProtectedPreview(resolved)) {
      setState({ error: '', previewSrc: resolved });
      return undefined;
    }
    const controller = new AbortController();
    let objectURL = '';
    setState({ error: '', previewSrc: '' });
    fetch(resolved, { headers: authHeader(), signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`预览读取失败 (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectURL = URL.createObjectURL(blob);
        setState({ error: '', previewSrc: objectURL });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ error: error.message || '预览读取失败', previewSrc: '' });
      });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [resolved]);

  return state;
}

function isProtectedPreview(src) {
  return String(src || '').startsWith('/api/');
}
