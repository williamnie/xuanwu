import { systemApi } from '../../api/system.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import { ImagePlus, Plus } from 'lucide-react';
import { filterPromptSuggestionItems } from './promptEditorSuggestions';
import { message } from '../../store/toastStore';
import './PromptEditor.css';
import PromptEditorComposerImages from './PromptEditorComposerImages';
import PromptEditorReferences from './PromptEditorReferences';
import PromptEditorToolbar from './PromptEditorToolbar';
import PromptSuggestionMenu from './PromptSuggestionMenu';
import { applyPromptSuggestion, updatePromptSuggestionMenu, usePromptEditor } from './usePromptEditor';
import {
  createComposerImageAttachment,
  serializeComposerPrompt,
  splitComposerImageAttachments,
} from './composerImageAttachments';
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
  showReferenceChips = true,
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
  const valueRef = useRef(value || '');
  const [uploading, setUploading] = useState(false);
  const [suggestionMenu, setSuggestionMenuState] = useState(null);
  const isComposer = variant === 'composer';
  const composerImageState = useMemo(
    () => (isComposer ? splitComposerImageAttachments(value) : { attachments: [], text: value || '' }),
    [isComposer, value],
  );
  const editorValue = isComposer ? composerImageState.text : value;

  const setSuggestionMenu = useCallback((nextMenu) => {
    setSuggestionMenuState((current) => {
      const resolved = typeof nextMenu === 'function' ? nextMenu(current) : nextMenu;
      suggestionMenuRef.current = resolved;
      return resolved;
    });
  }, []);
  const emitChange = useCallback((nextValue) => {
    valueRef.current = nextValue || '';
    onChange(nextValue);
  }, [onChange]);
  const handleEditorChange = useCallback((nextText) => {
    if (!isComposer) {
      emitChange(nextText);
      return;
    }
    const current = splitComposerImageAttachments(valueRef.current);
    emitChange(serializeComposerPrompt(current.attachments, nextText));
  }, [emitChange, isComposer]);

  const editor = usePromptEditor(editorValue, handleEditorChange, placeholder, uploadFiles, submitKeyRef, {
    suggestionsRef,
    attachReferenceRef,
    selectCommandRef,
    suggestionMenuRef,
    setSuggestionMenu,
  }, isComposer);

  useLayoutEffect(() => {
    submitKeyRef.current = onSubmitKey;
  }, [onSubmitKey]);

  useLayoutEffect(() => {
    valueRef.current = value || '';
  }, [value]);

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
      const nextAttachments = [];
      for (const image of images) {
        const upload = await systemApi.uploadImage(image);
        if (isComposer) {
          nextAttachments.push(createComposerImageAttachment(upload, image));
        } else {
          editor.chain().focus().setImage({
            src: `attachment://${upload.id}`,
            alt: upload.original_name || image.name,
          }).run();
        }
      }
      if (isComposer && nextAttachments.length > 0) {
        const current = splitComposerImageAttachments(valueRef.current);
        const currentText = editor.getMarkdown();
        emitChange(serializeComposerPrompt(
          [...current.attachments, ...nextAttachments.filter(Boolean)],
          currentText,
        ));
        editor.chain().focus().run();
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

  const removeComposerImage = (index) => {
    const current = splitComposerImageAttachments(valueRef.current);
    const currentText = editor.getMarkdown();
    emitChange(serializeComposerPrompt(
      current.attachments.filter((_item, itemIndex) => itemIndex !== index),
      currentText,
    ));
    editor.chain().focus().run();
  };

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
      <PromptEditorComposerImages
        attachments={composerImageState.attachments}
        onRemove={removeComposerImage}
      />
      {showReferenceChips && (
        <PromptEditorReferences
          details={referenceDetails}
          onRemove={onRemoveReference}
        />
      )}
      {editorShell}
    </div>
  );
}
