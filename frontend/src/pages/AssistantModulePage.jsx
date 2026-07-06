import { Boxes } from 'lucide-react';
import SettingsTabContent from './AssistantSettingsSections';
import { assistantModuleForPage } from './assistantModules';
import './Settings.css';

export default function AssistantModulePage({ page }) {
  const module = assistantModuleForPage(page) || assistantModuleForPage('pi-overview');
  return (
    <div className="assistant-module-page settings-page animate-fade-in">
      <header className="assistant-module-hero">
        <div>
          <div className="assistant-module-eyebrow">
            <Boxes size={14} /> PI Assistant Workbench
          </div>
          <h1>{module.title}</h1>
          <p>{module.description}</p>
        </div>
      </header>
      <div className="settings-tab-content assistant-module-content" role="tabpanel" aria-label={`PI Assistant ${module.title}`}>
        <SettingsTabContent activeTab={module.tab} />
      </div>
    </div>
  );
}
