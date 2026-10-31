import { copyPiDebugText, formatPiConversationDebugInfo } from './piChatDiagnostics';

export function openSupervisorSettings(navigateTo) {
  navigateTo('settings', null, '', '', { settingsSection: 'supervisor' });
}

export function copyConversationDebugInfo(event, conversation, successMessage) {
  if (!conversation) return;
  event?.preventDefault();
  copyPiDebugText(formatPiConversationDebugInfo(conversation), successMessage);
}
