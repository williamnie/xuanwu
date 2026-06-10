import { defaultUrlTransform } from 'react-markdown';
import { resolveAttachmentSrc } from './attachments.js';

export function resolveMarkdownPreviewUrl(value) {
  return defaultUrlTransform(resolveAttachmentSrc(value));
}
