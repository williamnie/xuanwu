const SUPPORTED_REFERENCE_TYPES = new Set(['file', 'folder', 'issue', 'project', 'skill', 'plugin']);
const LARGE_FILE_BYTES = 256 * 1024;
const LARGE_FOLDER_FILES = 500;

export function addSessionReference(current, reference) {
  const normalized = normalizeReference(reference);
  if (!normalized) return Array.isArray(current) ? current : [];
  const refs = Array.isArray(current) ? current : [];
  if (refs.some((item) => referenceKey(item) === referenceKey(normalized))) return refs;
  return [...refs, normalized];
}

export function removeSessionReference(current, key) {
  if (!Array.isArray(current)) return [];
  return current.filter((item) => referenceKey(item) !== key);
}

export function sessionPayloadWithReferences(prompt, fields = {}, references = []) {
  const payload = { ...fields, prompt };
  const refs = normalizeReferences(references);
  if (refs.length > 0) payload.references = refs;
  return payload;
}

export function buildReferenceDetails(references = [], context = {}) {
  return normalizeReferences(references).map((reference) => referenceDetail(reference, context));
}

export function referenceValidation(details = []) {
  const items = Array.isArray(details) ? details : [];
  if (items.some((item) => item.status === 'error')) {
    return { hasErrors: true, message: '请先移除 invalid reference 再发送。' };
  }
  return { hasErrors: false, message: '' };
}

export function hasComposerContent(prompt, references = []) {
  return Boolean(String(prompt || '').trim() || normalizeReferences(references).length > 0);
}

export function referenceKey(reference) {
  const ref = normalizeReference(reference);
  if (!ref) return '';
  return `${ref.type}:${ref.id || ref.path || ref.name || ref.label || ''}`;
}

export function normalizeReferences(references = []) {
  if (!Array.isArray(references)) return [];
  const seen = new Set();
  const normalized = [];
  for (const reference of references) {
    const ref = normalizeReference(reference);
    if (!ref) continue;
    const key = referenceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(ref);
  }
  return normalized;
}

function normalizeReference(reference) {
  const type = String(reference?.type || '').trim().toLowerCase();
  if (!SUPPORTED_REFERENCE_TYPES.has(type)) return null;
  const ref = {
    type,
    id: clean(reference.id),
    path: clean(reference.path),
    name: clean(reference.name),
    label: clean(reference.label),
    source: clean(reference.source) || 'composer',
    required: reference.required !== false,
  };
  if (reference.metadata && typeof reference.metadata === 'object') ref.metadata = { ...reference.metadata };
  return compactReference(ref);
}

function compactReference(reference) {
  const ref = { type: reference.type };
  for (const key of ['id', 'path', 'name', 'label', 'source']) {
    if (reference[key]) ref[key] = reference[key];
  }
  if (reference.required) ref.required = true;
  if (reference.metadata) ref.metadata = reference.metadata;
  return ref;
}

function referenceDetail(reference, context) {
  if (reference.type === 'issue') return issueDetail(reference, context.issues, context.currentProjectId);
  if (reference.type === 'project') return projectDetail(reference, context.projects, context.currentProjectId);
  if (reference.type === 'file') return pathDetail(reference, false);
  if (reference.type === 'folder') return pathDetail(reference, true);
  return registryDetail(reference);
}

function issueDetail(reference, issues = [], currentProjectId = '') {
  if (!Array.isArray(issues) || issues.length === 0) {
    const id = reference.id ? `#${reference.id}` : 'Issue';
    return withStatus(reference, 'ready', '', `${id} · ${reference.label || '已附加 issue reference'}`);
  }
  const issue = issues.find((item) => String(item.id) === String(reference.id));
  if (!reference.id || !issue) return withStatus(reference, 'error', 'Issue 不存在或未加载。', '缺少 issue context');
  const crossProject = currentProjectId && issue.project_id && issue.project_id !== currentProjectId;
  return withStatus(reference, crossProject ? 'warning' : 'ready', crossProject ? '跨 project issue，仅附加上下文，不切换执行项目。' : '',
    `#${issue.id} · ${issue.status || 'unknown'} · ${issue.title || reference.label || 'Untitled issue'}`);
}

function projectDetail(reference, projects = [], currentProjectId = '') {
  const project = projects.find((item) => item.id === reference.id);
  if (!reference.id || !project) return withStatus(reference, 'error', 'Project 不存在或未加载。', '缺少 project context');
  const crossProject = currentProjectId && project.id !== currentProjectId;
  return withStatus(reference, crossProject ? 'warning' : 'ready', crossProject ? '引用项目上下文，不切换执行项目。' : '',
    `${project.name || project.id} · ${project.cwd || 'cwd 未知'}`);
}

function pathDetail(reference, isFolder) {
  const path = reference.path || reference.id || reference.label;
  if (!path) return withStatus(reference, 'error', `${isFolder ? '目录' : '文件'}路径缺失。`, '路径缺失');
  const size = Number(reference.metadata?.size_bytes || 0);
  const count = Number(reference.metadata?.file_count || 0);
  const warning = (!isFolder && size > LARGE_FILE_BYTES) || (isFolder && count > LARGE_FOLDER_FILES);
  const summary = isFolder ? `${path} · ${count ? `${count} 个文件` : '目录摘要'}` : `${path} · ${size ? formatBytes(size) : '文件摘要'}`;
  return withStatus(reference, warning ? 'warning' : 'ready', warning ? '上下文较大，发送前请确认范围。' : '', summary);
}

function registryDetail(reference) {
  const name = reference.name || reference.id || reference.label;
  if (!name) return withStatus(reference, 'error', `${reference.type} 名称缺失。`, '名称缺失');
  return withStatus(reference, 'ready', '', reference.metadata?.summary || reference.label || name);
}

function withStatus(reference, status, message, summary) {
  return { ...reference, key: referenceKey(reference), status, message, summary };
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
