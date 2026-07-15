import { useEffect, useMemo, useState } from 'react';
import { projectsApi } from '../../api/projects.js';
import { buildSessionComposerSuggestions } from './sessionComposerAssist';
import { providerSupports } from './sessionOptions';
import { buildReferenceDetails, referenceValidation } from './sessionReferences';
import { sessionRuntimeSettingsKey } from './sessionRuntimeSettings';

const EMPTY_CAPABILITIES = { skills: [], plugins: [] };

export default function useSessionPageSelectors({
  projects,
  selectedSession,
  projectId,
  prompt,
  promptReferences,
  message,
  messageReferences,
  selectedId,
}) {
  const [pathReferences, setPathReferences] = useState({ files: [], folders: [] });
  const sessionProjects = useMemo(
    () => projects.filter((project) => providerSupports(project, 'sessions')),
    [projects],
  );
  const selectedProject = useMemo(
    () => sessionProjects.find((project) => project.id === projectId),
    [projectId, sessionProjects],
  );
  const selectedSessionProject = useMemo(() => {
    const sessionCwd = selectedSession?.cwd || selectedSession?.path || '';
    return projects.find((project) => project.cwd === sessionCwd) || null;
  }, [projects, selectedSession]);
  const referenceIssues = useMemo(() => [], []);
  const sessionComposerSuggestions = useMemo(() => buildSessionComposerSuggestions({
    projects,
    issues: referenceIssues,
    currentProject: selectedSessionProject,
    linkedIssues: selectedSession?.source_issues || [],
    capabilities: EMPTY_CAPABILITIES,
    pathReferences,
  }), [pathReferences, projects, referenceIssues, selectedSession?.source_issues, selectedSessionProject]);
  const newSessionReferenceDetails = useMemo(() => buildReferenceDetails(promptReferences, {
    issues: referenceIssues, projects, currentProjectId: projectId,
  }), [projectId, projects, promptReferences, referenceIssues]);
  const messageReferenceDetails = useMemo(() => buildReferenceDetails(messageReferences, {
    issues: referenceIssues, projects, currentProjectId: selectedSessionProject?.id || '',
  }), [messageReferences, projects, referenceIssues, selectedSessionProject?.id]);
  const newSessionReferenceValidation = useMemo(
    () => referenceValidation(newSessionReferenceDetails),
    [newSessionReferenceDetails],
  );
  const messageReferenceValidation = useMemo(
    () => referenceValidation(messageReferenceDetails),
    [messageReferenceDetails],
  );
  const newCommandContext = useMemo(() => ({
    prompt, references: promptReferences, projectId, sessionId: '', linkedIssues: [],
  }), [projectId, prompt, promptReferences]);
  const messageCommandContext = useMemo(() => ({
    prompt: message,
    references: messageReferences,
    projectId: selectedSessionProject?.id || '',
    sessionId: selectedId,
    linkedIssues: selectedSession?.source_issues || [],
  }), [message, messageReferences, selectedId, selectedSession?.source_issues, selectedSessionProject?.id]);
  const selectedSessionRuntimeKey = sessionRuntimeSettingsKey(selectedSession);
  const pathSearchRequest = useMemo(() => (
    pathReferenceSearchFromText(prompt, projectId) ||
    pathReferenceSearchFromText(message, selectedSessionProject?.id || '')
  ), [message, projectId, prompt, selectedSessionProject?.id]);

  useEffect(() => {
    if (!pathSearchRequest) {
      setPathReferences({ files: [], folders: [] });
      return undefined;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      projectsApi.searchProjectReferences(pathSearchRequest.projectId, {
        type: pathSearchRequest.type, query: pathSearchRequest.query, limit: 40,
      }).then((result) => {
        if (alive) setPathReferences({ files: result?.files || [], folders: result?.folders || [] });
      }).catch(() => {
        if (alive) setPathReferences({ files: [], folders: [] });
      });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [pathSearchRequest]);

  return {
    sessionProjects,
    selectedProject,
    selectedSessionProject,
    sessionComposerSuggestions,
    newSessionReferenceDetails,
    messageReferenceDetails,
    newSessionReferenceValidation,
    messageReferenceValidation,
    newCommandContext,
    messageCommandContext,
    selectedSessionRuntimeKey,
  };
}

function pathReferenceSearchFromText(text, projectId) {
  if (!projectId) return null;
  const match = String(text || '').match(/(?:^|\s)@(file|folder)\s+([^\n]*)$/i);
  if (!match) return null;
  return { projectId, type: match[1].toLowerCase(), query: match[2].trim() };
}
