import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
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
import { getPromptEditorExtensions } from './promptEditorCore';
import { handlePromptEditorSubmitKey } from './promptEditorKeyHandling';
import {
  detectPromptSuggestionContext,
  filterPromptSuggestionItems,
  insertPromptSuggestion,
  nextPromptSuggestionIndex,
  promptSuggestionKeyAction,
  samePromptSuggestionContext,
} from './promptEditorSuggestions';
import { message } from '../../store/toastStore';
import './PromptEditor.css';
import './PromptEditorSuggestions.css';

export default function PromptEditor({
  value,
  onChange,
  placeholder,
  minHeight = 160,
  variant = 'default',
  footerControls = null,
  actions = null,
  hideToolbar = false, // 新增参数：是否隐藏顶部工具条
  onSubmitKey = null,
  suggestions = [],
}) {
  const fileInputRef = useRef(null);
  const submitKeyRef = useRef(onSubmitKey);
  const suggestionsRef = useRef([]);
  const suggestionMenuRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [suggestionMenu, setSuggestionMenuState] = useState(null);

  const setSuggestionMenu = useCallback((nextMenu) => {
    setSuggestionMenuState((current) => {
      const resolved = typeof nextMenu === 'function' ? nextMenu(current) : nextMenu;
      suggestionMenuRef.current = resolved;
      return resolved;
    });
  }, []);

  const editor = usePromptEditor(value, onChange, placeholder, uploadFiles, submitKeyRef, {
    suggestionsRef,
    suggestionMenuRef,
    setSuggestionMenu,
  });
  const isComposer = variant === 'composer';

  useLayoutEffect(() => {
    submitKeyRef.current = onSubmitKey;
  }, [onSubmitKey]);

  useLayoutEffect(() => {
    suggestionsRef.current = Array.isArray(suggestions) ? suggestions : [];
  }, [suggestions]);

  const visibleSuggestions = useMemo(
    () => filterPromptSuggestionItems(suggestions, suggestionMenu?.context),
    [suggestions, suggestionMenu?.context],
  );

  useEffect(() => {
    if (!suggestionMenu || visibleSuggestions.length > 0) return;
    setSuggestionMenu(null);
  }, [setSuggestionMenu, suggestionMenu, visibleSuggestions.length]);

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
      message.error(`图片上传失败：${err.message || '网络异常'}`);
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
      {suggestionMenu && visibleSuggestions.length > 0 && (
        <PromptSuggestionMenu
          activeIndex={Math.min(suggestionMenu.activeIndex, visibleSuggestions.length - 1)}
          items={visibleSuggestions}
          onPick={(item) => {
            insertPromptSuggestion(editor, suggestionMenu.context, item);
            setSuggestionMenu(null);
          }}
        />
      )}
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

function usePromptEditor(value, onChange, placeholder, uploadFiles, submitKeyRef, suggestionState) {
  const editor = useEditor({
    extensions: getPromptEditorExtensions(placeholder),
    content: '',
    immediatelyRender: false,
    editorProps: {
      handleKeyDown: (_view, event) => handlePromptEditorKeyDown(event, submitKeyRef.current, suggestionState),
      handlePaste: (_view, event) => handleImageFiles(event.clipboardData?.files, uploadFiles),
      handleDrop: (_view, event) => handleImageFiles(event.dataTransfer?.files, uploadFiles),
      attributes: { 'aria-label': placeholder || 'Markdown editor' },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getMarkdown());
      updatePromptSuggestionMenu(current, suggestionState);
    },
    onSelectionUpdate: ({ editor: current }) => updatePromptSuggestionMenu(current, suggestionState),
    onBlur: () => window.setTimeout(() => suggestionState.setSuggestionMenu(null), 120),
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


function handlePromptEditorKeyDown(event, onSubmitKey, suggestionState) {
  const menu = suggestionState.suggestionMenuRef.current;
  const items = filterPromptSuggestionItems(suggestionState.suggestionsRef.current, menu?.context);
  if (menu && items.length > 0) {
    const action = promptSuggestionKeyAction(event);
    if (!action) return handlePromptEditorSubmitKey(event, onSubmitKey);
    event.preventDefault();
    if (action === 'next') setPromptSuggestionIndex(suggestionState, 1, items.length);
    if (action === 'previous') setPromptSuggestionIndex(suggestionState, -1, items.length);
    if (action === 'close') suggestionState.setSuggestionMenu(null);
    if (action === 'pick') {
      insertPromptSuggestion(menu.editor, menu.context, items[Math.min(menu.activeIndex, items.length - 1)]);
      suggestionState.setSuggestionMenu(null);
    }
    return true;
  }
  return handlePromptEditorSubmitKey(event, onSubmitKey);
}

function updatePromptSuggestionMenu(editor, suggestionState) {
  const context = detectPromptSuggestionContext(editor);
  if (!context) {
    if (suggestionState.suggestionMenuRef.current) suggestionState.setSuggestionMenu(null);
    return;
  }
  const items = filterPromptSuggestionItems(suggestionState.suggestionsRef.current, context);
  if (items.length === 0) {
    if (suggestionState.suggestionMenuRef.current) suggestionState.setSuggestionMenu(null);
    return;
  }
  if (samePromptSuggestionContext(suggestionState.suggestionMenuRef.current?.context, context)) return;
  suggestionState.setSuggestionMenu({ context, activeIndex: 0, editor });
}

function setPromptSuggestionIndex(suggestionState, delta, count) {
  suggestionState.setSuggestionMenu((current) => current && ({
    ...current,
    activeIndex: nextPromptSuggestionIndex(current.activeIndex, delta, count),
  }));
}

function PromptSuggestionMenu({ items, activeIndex, onPick }) {
  return (
    <div className="prompt-suggestion-menu" role="listbox" aria-label="输入建议">
      {items.map((item, index) => (
        <button
          key={item.id || `${item.trigger}-${item.label}`}
          type="button"
          className={`prompt-suggestion-item ${index === activeIndex ? 'active' : ''}`}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
        >
          <span className="prompt-suggestion-label">{item.label}</span>
          {item.description && <span className="prompt-suggestion-description">{item.description}</span>}
        </button>
      ))}
      <div className="prompt-suggestion-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
    </div>
  );
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
