import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { ImagePlus, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { getPromptEditorExtensions } from './promptEditorCore';
import { handlePromptEditorSubmitKey } from './promptEditorKeyHandling';
import {
  detectPromptSuggestionContext,
  filterPromptSuggestionItems,
  insertPromptSuggestion,
  removePromptSuggestionTrigger,
  nextPromptSuggestionIndex,
  promptSuggestionKeyAction,
  samePromptSuggestionContext,
} from './promptEditorSuggestions';
import { message } from '../../store/toastStore';
import './PromptEditor.css';
import PromptEditorReferences from './PromptEditorReferences';
import PromptEditorToolbar from './PromptEditorToolbar';
import './PromptEditorSuggestions.css';
import './PromptEditorReferences.css';

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
  referenceDetails = [],
  onAttachReference = null,
  onRemoveReference = null,
  onSelectCommand = null,
}) {
  const fileInputRef = useRef(null);
  const submitKeyRef = useRef(onSubmitKey);
  const suggestionsRef = useRef([]);
  const attachReferenceRef = useRef(onAttachReference);
  const selectCommandRef = useRef(onSelectCommand);
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
    attachReferenceRef,
    selectCommandRef,
    suggestionMenuRef,
    setSuggestionMenu,
  });
  const isComposer = variant === 'composer';

  useLayoutEffect(() => {
    submitKeyRef.current = onSubmitKey;
  }, [onSubmitKey]);

  useLayoutEffect(() => {
    suggestionsRef.current = Array.isArray(suggestions) ? suggestions : [];
    if (editor) {
      updatePromptSuggestionMenu(editor, {
        suggestionsRef,
        attachReferenceRef,
        selectCommandRef,
        suggestionMenuRef,
        setSuggestionMenu,
      });
    }
  }, [editor, setSuggestionMenu, suggestions]);

  useLayoutEffect(() => {
    attachReferenceRef.current = onAttachReference;
  }, [onAttachReference]);

  useLayoutEffect(() => {
    selectCommandRef.current = onSelectCommand;
  }, [onSelectCommand]);

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

  const editorShell = (
    <div className={`prompt-editor-shell ${isComposer ? 'composer' : ''} ${editor.isFocused ? 'focused' : ''}`}>
      {!isComposer && !hideToolbar && <PromptEditorToolbar editor={editor} onPickImage={() => fileInputRef.current?.click()} uploading={uploading} />}
      <EditorContent editor={editor} className={`prompt-editor-content ${isComposer ? 'composer' : ''}`} style={{ minHeight }} />
      {suggestionMenu && visibleSuggestions.length > 0 && (
        <PromptSuggestionMenu
          activeIndex={Math.min(suggestionMenu.activeIndex, visibleSuggestions.length - 1)}
          items={visibleSuggestions}
          onPick={(item) => {
            applyPromptSuggestion(editor, suggestionMenu.context, item, {
              attachReference: attachReferenceRef.current,
              selectCommand: selectCommandRef.current,
            });
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

  if (!isComposer) return editorShell;

  return (
    <div className="prompt-editor-composer-stack">
      <PromptEditorReferences
        details={referenceDetails}
        onRemove={onRemoveReference}
      />
      {editorShell}
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
      applyPromptSuggestion(menu.editor, menu.context, items[Math.min(menu.activeIndex, items.length - 1)], {
        attachReference: suggestionState.attachReferenceRef.current,
        selectCommand: suggestionState.selectCommandRef.current,
      });
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

function applyPromptSuggestion(editor, context, item, { attachReference, selectCommand } = {}) {
  if (item?.command && selectCommand) {
    removePromptSuggestionTrigger(editor, context);
    selectCommand(item.command);
    return true;
  }
  if (item?.reference && attachReference) {
    removePromptSuggestionTrigger(editor, context);
    attachReference(item.reference);
    return true;
  }
  return insertPromptSuggestion(editor, context, item);
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
