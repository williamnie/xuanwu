const ATTACHMENT_IMAGE_PATTERN = /!\[((?:\\.|[^\]\n])*)\]\((attachment:\/\/[A-Za-z0-9_-]+)(?:\s+["'][^"']*["'])?\)/g;

export function splitComposerImageAttachments(markdown = '') {
  const attachments = [];
  const text = String(markdown).replace(ATTACHMENT_IMAGE_PATTERN, (_match, alt, src) => {
    attachments.push({ alt: normalizeImageAlt(alt), src });
    return '';
  });
  return { attachments, text: normalizeComposerText(text) };
}

export function serializeComposerPrompt(attachments = [], text = '') {
  const imageMarkdown = attachments.map(composerImageMarkdown).filter(Boolean).join('\n\n');
  const body = normalizeComposerText(text);
  if (imageMarkdown && body) return `${imageMarkdown}\n\n${body}`;
  return imageMarkdown || body;
}

export function createComposerImageAttachment(upload, fallbackFile) {
  const id = String(upload?.id || '').trim();
  if (!id) return null;
  return {
    alt: normalizeImageAlt(upload?.original_name || fallbackFile?.name || 'uploaded image'),
    src: `attachment://${id}`,
  };
}

function composerImageMarkdown(attachment) {
  const src = String(attachment?.src || '').trim();
  if (!src.startsWith('attachment://')) return '';
  return `![${escapeImageAlt(attachment?.alt || 'uploaded image')}](${src})`;
}

function escapeImageAlt(value) {
  return normalizeImageAlt(value).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function normalizeImageAlt(value) {
  return String(value || 'uploaded image').replace(/\\([\\\]])/g, '$1').replace(/\s+/g, ' ').trim() || 'uploaded image';
}

function normalizeComposerText(value) {
  return String(value || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
