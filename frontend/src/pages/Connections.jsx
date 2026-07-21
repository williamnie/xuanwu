import { useState } from 'react';
import { Bot, Cable, PlugZap, Workflow } from 'lucide-react';
import { PRODUCT_NAV_LABELS } from '../brand.js';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel';
import FeishuSettingsPanel from './FeishuSettingsPanel';
import PiAgentSettingsPanel from './PiAgentSettingsPanel';
import PiMcpManagementPanel from './PiMcpManagementPanel';
import './Connections.css';

const CONNECTION_SECTIONS = Object.freeze([
  { id: 'providers', label: 'AI Providers', icon: Bot },
  { id: 'pi-agent', label: 'PI Agent', icon: Workflow },
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'mcp', label: 'MCP', icon: PlugZap },
]);

export default function Connections({ initialSection = 'providers' }) {
  const [activeSection, setActiveSection] = useState(() => connectionSection(initialSection));
  return (
    <div className="connections-page animate-fade-in">
      <header className="connections-hero">
        <div>
          <span className="connections-kicker"><Workflow size={14} /> Runtime connectivity</span>
          <h1>{PRODUCT_NAV_LABELS.connections}</h1>
          <p>先连接 AI provider，再配置 PI Agent；Provider 连接与 Supervisor 行为分别保存，互不覆盖。</p>
        </div>
      </header>
      <nav className="connections-tabs" role="tablist" aria-label="Connection types">
        {CONNECTION_SECTIONS.map(({ icon: Icon, ...section }) => (
          <button
            aria-selected={activeSection === section.id}
            className={`connections-tab ${activeSection === section.id ? 'active' : ''}`}
            key={section.id}
            onClick={() => setActiveSection(section.id)}
            role="tab"
            type="button"
          >
            <Icon size={15} /> {section.label}
          </button>
        ))}
      </nav>
      <main className="connections-content" role="tabpanel">
        {activeSection === 'providers' && <PiAgentSettingsPanel view="connection" />}
        {activeSection === 'pi-agent' && <PiAgentSettingsPanel view="agent" />}
        {activeSection === 'integrations' && <IntegrationsSection />}
        {activeSection === 'mcp' && <PiMcpManagementPanel />}
      </main>
    </div>
  );
}

function IntegrationsSection() {
  return (
    <>
      <ConnectorDiagnosticsPanel />
      <FeishuSettingsPanel />
    </>
  );
}

function connectionSection(value) {
  return CONNECTION_SECTIONS.some(section => section.id === value) ? value : 'providers';
}
