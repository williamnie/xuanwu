export function parseTelegramProjectMappings(value) {
  return String(value || '').split(/[\n,]/).filter(item => item.trim()).map(item => {
    const separator = item.indexOf('=');
    return separator < 0 ? { source: item.trim(), projectId: '' } : {
      source: item.slice(0, separator).trim(), projectId: item.slice(separator + 1).trim(),
    };
  });
}

export function serializeTelegramProjectMappings(rows) {
  return rows.map(({ source, projectId }) => `${source}=${projectId}`).join(',');
}
