import { projectOptionLabel } from '../utils/projectOptionLabel.js';
import { useProjectNodes } from '../store/useProjectNodes.js';
import { useI18n } from '../i18n/context.js';
import { selectProjects, useDataStore } from '../store/dataStore.js';
import { parseTelegramProjectMappings, serializeTelegramProjectMappings } from './telegramProjectMappings.js';

export default function TelegramProjectMappings({ onChange, value }) {
  const projects = useDataStore(selectProjects);
  return <TelegramProjectMappingsView onChange={onChange} projects={projects} value={value} />;
}

export function TelegramProjectMappingsView({ onChange, projects, value }) {
  const nodesById = useProjectNodes();
  const { language } = useI18n();
  const english = language === 'en-US';
  const rows = parseTelegramProjectMappings(value);
  const updateRows = next => onChange(serializeTelegramProjectMappings(next));
  const update = (index, patch) => updateRows(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return (
    <div className="telegram-project-mappings">
      <h3 className="settings-subsection-title">{english ? 'Project mappings' : '项目映射'}</h3>
      <p className="feishu-settings__hint-copy">{english ? 'Map each chat or user to an existing project.' : '为每个群聊或用户选择关联的已有项目。'}</p>
      {rows.map((row, index) => (
        <div className="telegram-project-mapping" key={index}>
          <label className="form-group feishu-settings__field"><span className="ds-mono-label">{english ? 'Source (chat: / user:)' : '来源（chat: / user:）'}</span>
            <input className="form-control" required value={row.source} placeholder="chat:-100123" onChange={event => update(index, { source: event.target.value })} />
          </label>
          <label className="form-group feishu-settings__field"><span className="ds-mono-label">{english ? 'Project' : '项目'}</span>
            <select className="form-control" required value={row.projectId} onChange={event => update(index, { projectId: event.target.value })}>
              <option value="">{english ? 'Choose a project' : '选择项目'}</option>
              {row.projectId && !projects.some(project => project.id === row.projectId) && <option value={row.projectId}>{row.projectId} · {english ? 'Current value (unavailable)' : '当前值（暂不可用）'}</option>}
              {projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name || project.id)} · {project.id}</option>)}
            </select>
          </label>
          <button className="btn btn-secondary" type="button" onClick={() => updateRows(rows.filter((_, i) => i !== index))}>{english ? 'Remove' : '移除'}</button>
        </div>
      ))}
      <div><button className="btn btn-secondary" type="button" onClick={() => updateRows([...rows, { source: 'chat:', projectId: '' }])}>{english ? 'Add mapping' : '添加映射'}</button></div>
    </div>
  );
}
