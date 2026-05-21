export function attachmentURL(id) {
  if (!id) return '';
  return `/api/uploads/${encodeURIComponent(id)}/content`;
}

export function resolveAttachmentSrc(src) {
  if (!src || typeof src !== 'string') return src || '';
  if (src.startsWith('attachment://')) {
    return attachmentURL(src.slice('attachment://'.length));
  }
  return src;
}

export function localImagePathToAttachmentMarkdown(path, alt = 'uploaded image') {
  if (!path || typeof path !== 'string') return '';
  const filename = path.split('/').pop() || '';
  const id = filename.replace(/\.[^.]+$/, '');
  if (!id.startsWith('upload_')) return `![${alt}](${path})`;
  return `![${alt}](attachment://${id})`;
}
