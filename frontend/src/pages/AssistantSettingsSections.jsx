import PiMemoryPanel from './PiMemoryPanel';
import ActivityTimelinePanel from './ActivityTimelinePanel';
import ProviderAvailabilityPanel from './ProviderAvailabilityPanel';
import PermissionsSettingsPanel from './PermissionsSettingsPanel';
import NotificationSettingsPanel from './NotificationSettingsPanel';
import RunnerSettingsPanel from './RunnerSettingsPanel';
import SkillsRuntimePanel from './SkillsRuntimePanel';
import SourcePoliciesPanel from './SourcePoliciesPanel';
import ProjectSettingsEditor from './ProjectSettingsEditor';
import { RestartAction } from './SettingsChrome';
import { FolderCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { selectProjects, selectRefreshData, useDataStore } from '../store/dataStore.js';

export default function SettingsTabContent({ activeTab, initialProjectId, RuntimeStatusPanel, navigateTo, tier }) {
  if (tier === 'advanced') {
    return <AdvancedSettingsTab activeTab={activeTab} RuntimeStatusPanel={RuntimeStatusPanel} navigateTo={navigateTo} />;
  }
  return (
    <>
      {activeTab === 'general' && <GeneralSettingsTab initialProjectId={initialProjectId} navigateTo={navigateTo} />}
      {activeTab === 'permissions' && <PermissionsSettingsTab navigateTo={navigateTo} />}
      {activeTab === 'notifications' && <NotificationsSettingsTab />}
    </>
  );
}

function GeneralSettingsTab({ initialProjectId, navigateTo }) {
  const { t } = useI18n();
  const projects = useDataStore(selectProjects);
  const refreshData = useDataStore(selectRefreshData);
  const [selectedProjectID, setSelectedProjectID] = useState(initialProjectId || '');

  useEffect(() => {
    setSelectedProjectID(current => {
      if (projects.some(project => project.id === current)) return current;
      if (projects.some(project => project.id === initialProjectId)) return initialProjectId;
      return projects[0]?.id || '';
    });
  }, [initialProjectId, projects]);

  const project = projects.find(item => item.id === selectedProjectID) || null;

  return (
    <section className="glass-card settings-project-panel">
      <div className="settings-project-panel-header">
        <div className="settings-project-heading">
          <div className="settings-entry-eyebrow"><FolderCog size={14} /> {t('settings.perProject')}</div>
          <h2>{t('settings.projectSettings')}</h2>
          <p>{t('settings.projectSettingsDescription')}</p>
        </div>
        {projects.length > 0 && (
          <label className="settings-project-select">
            <span>{t('settings.selectProject')}</span>
            <select className="form-control" onChange={event => setSelectedProjectID(event.target.value)} value={selectedProjectID}>
              {projects.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
            </select>
          </label>
        )}
      </div>

      {project ? (
        <ProjectSettingsEditor
          key={project.id}
          mode="edit"
          onSaved={() => refreshData(['projects'])}
          project={project}
        />
      ) : (
        <div className="settings-project-empty">
          <strong>{t('settings.noProjects')}</strong>
          <p>{t('settings.noProjectsDescription')}</p>
          <button className="btn btn-primary" onClick={() => navigateTo?.('projects')} type="button">{t('settings.openProjects')}</button>
        </div>
      )}
    </section>
  );
}

function PermissionsSettingsTab({ navigateTo }) {
  return <PermissionsSettingsPanel navigateTo={navigateTo} />;
}

function NotificationsSettingsTab() {
  return <NotificationSettingsPanel />;
}

function AdvancedSettingsTab({ activeTab, RuntimeStatusPanel, navigateTo }) {
  return (
    <>
      {activeTab === 'runtime' && <AdvancedRuntimeSettingsTab RuntimeStatusPanel={RuntimeStatusPanel} />}
      {activeTab === 'skills' && <AdvancedSkillsSettingsTab />}
      {activeTab === 'memory' && <MemorySettingsTab />}
      {activeTab === 'activity' && <ActivityTimelinePanel navigateTo={navigateTo} />}
      {activeTab === 'policies' && <SourcePoliciesPanel />}
    </>
  );
}

function AdvancedRuntimeSettingsTab({ RuntimeStatusPanel }) {
  const { t } = useI18n();
  return (
    <>
      <section className="glass-card settings-advanced-danger-zone">
        <div>
          <div className="settings-entry-eyebrow">{t('settings.advancedRuntime')}</div>
          <h2>{t('settings.serviceLifecycle')}</h2>
          <p>{t('settings.restartDescription')}</p>
        </div>
        <RestartAction />
      </section>
      <RuntimeStatusPanel />
      <RunnerSettingsPanel />
      <ProviderAvailabilityPanel />
    </>
  );
}

function AdvancedSkillsSettingsTab() {
  return <SkillsRuntimePanel />;
}

function MemorySettingsTab() {
  return <PiMemoryPanel />;
}
