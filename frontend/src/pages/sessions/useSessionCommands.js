import { validateSessionCommand, buildRunnerCommandRequest } from './sessionCommands';
import { systemApi } from '../../api/system.js';

export default function useSessionCommands({
  promptCommand,
  newCommandContext,
  setPromptCommandResult,
  setPromptCommandError,
  refreshData,
  setPrompt,
  setPromptReferences,
  messageCommand,
  messageCommandContext,
  setMessageCommandResult,
  setMessageCommandError,
  setMessage,
  setMessageReferences,
  commandExecuting,
  setCommandExecuting,
  loadSelected,
}) {
  const executeNewSessionCommand = async () => {
    await executeSessionCommand({
      commandState: promptCommand,
      context: newCommandContext,
      setResult: setPromptCommandResult,
      setError: setPromptCommandError,
      afterSuccess: async () => {
        await refreshData(['workSummary']);
        setPrompt('');
        setPromptReferences([]);
      },
    });
  };

  const executeMessageCommand = async () => {
    await executeSessionCommand({
      commandState: messageCommand,
      context: messageCommandContext,
      setResult: setMessageCommandResult,
      setError: setMessageCommandError,
      afterSuccess: async () => {
        await refreshData(['workSummary']);
        setMessage('');
        setMessageReferences([]);
      },
    });
  };

  const executeSessionCommand = async ({ commandState, context, setResult, setError, afterSuccess }) => {
    if (!commandState || commandExecuting) return;
    const validation = validateSessionCommand(commandState, context);
    if (validation) {
      setError(validation);
      return;
    }
    setCommandExecuting(true);
    setError('');
    try {
      const result = await systemApi.executeCommand(buildRunnerCommandRequest(commandState, context, { confirmed: true }));
      setResult(result);
      if (context.sessionId) {
        await loadSelected(false);
      }
      await afterSuccess?.(result);
    } catch (err) {
      setError(err.message || 'Command 执行失败');
    } finally {
      setCommandExecuting(false);
    }
  };

  return { executeNewSessionCommand, executeMessageCommand };
}
