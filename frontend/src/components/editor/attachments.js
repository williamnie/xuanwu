export function attachmentURL(id) {
  if (!id) return '';
  return `/api/uploads/${encodeURIComponent(id)}/content`;
}

export function sessionImageURL(path) {
  if (!path) return '';
  return `/api/session-images?path=${encodeURIComponent(path)}`;
}

export function resolveAttachmentSrc(src) {
  if (!src || typeof src !== 'string') return src || '';
  if (src.startsWith('attachment://')) {
    return attachmentURL(src.slice('attachment://'.length));
  }
  const localImagePath = codexClipboardImagePath(src);
  if (localImagePath) {
    return sessionImageURL(localImagePath);
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

function codexClipboardImagePath(src) {
  const path = normalizeLocalPath(src);
  if (!path) return '';
  const name = path.split(/[\\/]/).pop() || '';
  return /^codex-clipboard-[^\\/]+\.(png|jpe?g|webp|gif)$/i.test(name) ? path : '';
}

function normalizeLocalPath(src) {
  if (src.startsWith('file://')) {
    try {
      const url = new URL(src);
      return decodeURIComponent(url.pathname || '');
    } catch {
      return '';
    }
  }
  return src.startsWith('/') ? src : '';
}
