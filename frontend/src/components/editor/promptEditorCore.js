import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { resolveAttachmentSrc } from './attachments.js';
import { isLocalMarkdownSelfLink } from './localDocLinks.js';

const AttachmentImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes, src: resolveAttachmentSrc(HTMLAttributes.src) };
    return ['img', mergeAttributes(this.options.HTMLAttributes, attrs)];
  },
});

const ManualLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    // Markdown 解析器也会识别裸 URL；与输入/粘贴一致，仅保留显式 Markdown 链接。
    const isBareUrl = typeof token.raw === 'string' && token.raw === token.text;
    if (isBareUrl || isLocalMarkdownSelfLink(token.text, token.href)) {
      return helpers.createTextNode(token.raw || `[${token.text}](${token.href})`);
    }
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: token.title || null,
    });
  },

  addPasteRules() {
    return [];
  },
});

export function getPromptEditorExtensions(placeholder = '') {
  return [
    StarterKit.configure({ link: false }),
    AttachmentImage.configure({ allowBase64: false }),
    ManualLink.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      defaultProtocol: 'https',
    }),
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
}
