const MAX_PENDING_PROMPT_VALUES = 32;

export function enqueueLocalPromptValue(pendingValues, nextValue) {
  const nextPending = [...pendingValues, nextValue];
  return nextPending.slice(-MAX_PENDING_PROMPT_VALUES);
}

export function reconcilePromptEditorValue(currentValue, nextValue, pendingValues) {
  const emittedIndex = pendingValues.indexOf(nextValue);
  if (emittedIndex >= 0) {
    return {
      apply: false,
      pendingValues: pendingValues.slice(emittedIndex + 1),
    };
  }
  return {
    apply: currentValue !== nextValue,
    pendingValues: [],
  };
}
