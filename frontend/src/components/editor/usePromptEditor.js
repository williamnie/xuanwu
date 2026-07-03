import { useEffect } from 'react';
import { useEditor } from '@tiptap/react';
import { getPromptEditorExtensions } from './promptEditorCore';
import { handlePromptEditorSubmitKey } from './promptEditorKeyHandling';
import {
  detectPromptSuggestionContext,
  filterPromptSuggestionItems,
  insertPromptSuggestion,
  nextPromptSuggestionIndex,
  promptSuggestionKeyAction,
  removePromptSuggestionTrigger,
  samePromptSuggestionContext,
} from './promptEditorSuggestions';

export function usePromptEditor(value, onChange, placeholder, uploadFiles, submitKeyRef, suggestionState) {
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

export function updatePromptSuggestionMenu(editor, suggestionState) {
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

export function applyPromptSuggestion(editor, context, item, { attachReference, selectCommand } = {}) {
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

function setPromptSuggestionIndex(suggestionState, delta, count) {
  suggestionState.setSuggestionMenu((current) => current && ({
    ...current,
    activeIndex: nextPromptSuggestionIndex(current.activeIndex, delta, count),
  }));
}

function handleImageFiles(files, uploadFiles) {
  const images = Array.from(files || []).filter(file => file.type.startsWith('image/'));
  if (!images.length) return false;
  uploadFiles(images);
  return true;
}
