import './RemoteProjectBadge.css';

export default function RemoteProjectBadge({ project, nodesById }) {
  if (!project?.node_id) return null;
  const node = nodesById?.get(project.node_id);
  const location = `${node?.name || project.node_id}:${project.node_path || ''}`;
  return (
    <span className="project-card-remote ds-mono-label" title={`远程项目 · ${location}`}>
      <span className="status-dot" aria-hidden="true" />
      远程
    </span>
  );
}
