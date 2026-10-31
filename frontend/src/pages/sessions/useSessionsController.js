import useSessionPageSelectors from './useSessionPageSelectors';
import useNewSessionProviders from './useNewSessionProviders.js';
import { useEffect } from 'react';
import { removeQueuedSessionMessage, retryQueuedSessionMessage } from './sessionMessageQueue';
import useSessionPageState from './useSessionPageState.js';
import useSessionLoaders from './useSessionLoaders.js';
import useSessionProviderSettings from './useSessionProviderSettings.js';
import useSessionRealtime from './useSessionRealtime.js';
import useSessionProjectActions from './useSessionProjectActions.js';
import useSessionMessageActions from './useSessionMessageActions.js';
import useSessionCommands from './useSessionCommands.js';
import useSessionActions from './useSessionActions.js';
import useSessionCreation from './useSessionCreation.js';

export default function useSessionsController(options) {
  const state = useSessionPageState(options);
  const { projects, selectedId, selectedSession, projectId, prompt, promptReferences, providerRuntimeStatus, providerCatalog, message, messageReferences } = state;
  const selectors = useSessionPageSelectors({
    projects, selectedSession, projectId, prompt, promptReferences, message, messageReferences, selectedId,
  });
  const { selectedProject } = selectors;

  const { nodeId, newProviderCatalog, newProviderStatus, newSessionBlockedReason } =
    useNewSessionProviders(selectedProject, projectId, providerCatalog, providerRuntimeStatus);

  const context = { ...options, ...state, ...selectors, nodeId, newProviderCatalog, newProviderStatus, newSessionBlockedReason };
  const loaders = useSessionLoaders(context);
  Object.assign(context, loaders);
  useSessionProviderSettings(context);
  useSessionRealtime(context);
  const projectActions = useSessionProjectActions(context);
  const messages = useSessionMessageActions(context);
  Object.assign(context, messages);
  const commands = useSessionCommands(context);
  const actions = useSessionActions(context);
  const creation = useSessionCreation(context);
  const refreshData = state.refreshData;
  useEffect(() => { refreshData(['projects']); }, [refreshData]);
  return {
    ...context, ...projectActions, ...commands, ...actions, ...creation,
    cancelQueuedMessage: (id) => state.setMessageQueue((current) => removeQueuedSessionMessage(current, id)),
    retryQueuedMessage: (id) => state.setMessageQueue((current) => retryQueuedSessionMessage(current, id)),
  };
}
