import { useEffect, useRef, useState } from 'react';
import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Code,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Plus,
  Quote,
} from 'lucide-react';
import { api } from '../../api/client';
import { resolveAttachmentSrc } from './attachments';
import './PromptEditor.css';

const AttachmentImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes, src: resolveAttachmentSrc(HTMLAttributes.src) };
    return ['img', mergeAttributes(this.options.HTMLAttributes, attrs)];
  },
});

export default function PromptEditor({
  value,
  onChange,
  placeholder,
  minHeight = 160,
  variant = 'default',
  footerControls = null,
  actions = null,
  hideToolbar = false, // 新增参数：是否隐藏顶部工具条
}) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const editor = usePromptEditor(value, onChange, placeholder, uploadFiles);
  const isComposer = variant === 'composer';

  async function uploadFiles(files) {
    const images = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (!images.length || !editor) return;
    setUploading(true);
    try {
      for (const image of images) {
        const upload = await api.uploadImage(image);
        editor.chain().focus().setImage({
          src: `attachment://${upload.id}`,
          alt: upload.original_name || image.name,
        }).run();
      }
    } catch (err) {
      window.alert(`图片上传失败：${err.message || '网络异常'}`);
    } finally {
      setUploading(false);
    }
  }

  if (!editor) {
    return <div className={`prompt-editor-shell ${isComposer ? 'composer' : ''}`} style={{ minHeight }} />;
  }

  return (
    <div className={`prompt-editor-shell ${isComposer ? 'composer' : ''} ${editor.isFocused ? 'focused' : ''}`}>
      {!isComposer && !hideToolbar && <PromptToolbar editor={editor} onPickImage={() => fileInputRef.current?.click()} uploading={uploading} />}
      <EditorContent editor={editor} className={`prompt-editor-content ${isComposer ? 'composer' : ''}`} style={{ minHeight }} />
      {isComposer && (
        <div className="prompt-composer-footer">
          <div className="prompt-composer-left">
            <button
              type="button"
              className="prompt-composer-add"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title={uploading ? '图片上传中' : '添加图片'}
            >
              {uploading ? <ImagePlus size={16} /> : <Plus size={17} />}
            </button>
            {footerControls}
          </div>
          {actions && <div className="prompt-composer-actions">{actions}</div>}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          uploadFiles(event.target.files || []);
          event.target.value = '';
        }}
      />
    </div>
  );
}

function usePromptEditor(value, onChange, placeholder, uploadFiles) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      AttachmentImage.configure({ allowBase64: false }),
      Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    content: '',
    immediatelyRender: false,
    editorProps: {
      handlePaste: (_view, event) => handleImageFiles(event.clipboardData?.files, uploadFiles),
      handleDrop: (_view, event) => handleImageFiles(event.dataTransfer?.files, uploadFiles),
      attributes: { 'aria-label': placeholder || 'Markdown editor' },
    },
    onUpdate: ({ editor: current }) => onChange(current.getMarkdown()),
  });

  useEffect(() => {
    if (!editor) return;
    const current = editor.getMarkdown();
    const next = value || '';
    if (current !== next) {
      editor.commands.setContent(next, { contentType: 'markdown', emitUpdate: false });
    }
  }, [editor, value]);

  return editor;
}

function handleImageFiles(files, uploadFiles) {
  const images = Array.from(files || []).filter(file => file.type.startsWith('image/'));
  if (!images.length) return false;
  uploadFiles(images);
  return true;
}

function PromptToolbar({ editor, onPickImage, uploading }) {
  const button = (label, icon, active, onClick) => (
    <button type="button" className={`prompt-tool ${active ? 'active' : ''}`} onClick={onClick} title={label}>
      {icon}
    </button>
  );
  return (
    <div className="prompt-toolbar">
      {button('标题', <Heading2 size={15} />, editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      {button('加粗', <Bold size={15} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {button('斜体', <Italic size={15} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {button('行内代码', <Code size={15} />, editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
      {button('列表', <List size={15} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {button('有序列表', <ListOrdered size={15} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {button('引用', <Quote size={15} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {button('链接', <LinkIcon size={15} />, editor.isActive('link'), () => setLink(editor))}
      <button type="button" className="prompt-tool image" onClick={onPickImage} disabled={uploading} title="上传图片">
        <ImagePlus size={15} /> {uploading ? '上传中' : '图片'}
      </button>
    </div>
  );
}

function setLink(editor) {
  const previous = editor.getAttributes('link').href || '';
  const href = window.prompt('输入链接 URL', previous);
  if (href === null) return;
  if (href === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}
