import {
  Bold,
  Code,
  Heading2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
} from 'lucide-react';

export default function PromptEditorToolbar({ editor, onPickImage, uploading }) {
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
