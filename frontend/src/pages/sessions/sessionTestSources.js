import { readFileSync } from 'node:fs';

function readSources(files) {
  return files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
}

// 源码合同覆盖明确的页面所有者，避免遍历公共依赖带入无关实现。
export function readSessionPageSource() {
  return readSources([
    '../Sessions.jsx',
    './useSessionsController.js',
    './useSessionPageState.js',
    './useSessionLoaders.js',
    './useSessionProviderSettings.js',
    './useSessionRealtime.js',
    './useSessionProjectActions.js',
    './useSessionMessageActions.js',
    './useSessionCommands.js',
    './useSessionActions.js',
    './useSessionCreation.js',
  ]);
}

export function readSessionTranscriptSource() {
  return readSources([
    './SessionTranscript.jsx',
    './SessionTranscriptHeader.jsx',
    './SessionTranscriptTurns.jsx',
    './SessionTranscriptTools.jsx',
    './SessionMessageContent.jsx',
    './sessionTranscriptDiff.js',
  ]);
}

export function readSessionComposerSource() {
  return readSources([
    './SessionComposer.jsx',
    './SessionComposerStatus.jsx',
    './SessionComposerActions.jsx',
    './SessionRuntimeControls.jsx',
    './sessionComposerLabels.js',
  ]);
}
