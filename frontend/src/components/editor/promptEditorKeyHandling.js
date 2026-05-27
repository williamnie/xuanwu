export function shouldSubmitPromptEditorKey(event) {
  return event?.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229;
}

export function handlePromptEditorSubmitKey(event, onSubmitKey) {
  if (!onSubmitKey || !shouldSubmitPromptEditorKey(event)) return false;
  event.preventDefault();
  onSubmitKey(event);
  return true;
}
