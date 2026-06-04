export function promptWithProjectContext(text, project) {
  if (!project?.id) return text;
  return [
    `目标项目：@project:${project.id} ${project.name || project.id}`,
    `项目路径：${project.cwd || '未记录'}`,
    '',
    text
  ].join('\n');
}

export function projectFromPrompt(text, projects = []) {
  const body = String(text || '').toLowerCase();
  const items = Array.isArray(projects) ? projects.filter((project) => project?.id) : [];
  return items
    .slice()
    .sort((left, right) => String(right.id).length - String(left.id).length)
    .find((project) => projectMentionTokens(project).some((token) => body.includes(token))) || null;
}

export function referenceKey(reference) {
  return `${reference?.type || ''}:${reference?.id || ''}`;
}

export function cleanProjectText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function projectMentionTokens(project) {
  const id = cleanProjectText(project.id).toLowerCase();
  const name = cleanProjectText(project.name).toLowerCase();
  return [`@${id}`, `@project:${id}`, `@project ${id}`, name && !name.includes(' ') ? `@${name}` : ''].filter(Boolean);
}
