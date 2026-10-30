

export function parseDiff(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      let fullPath;
      if (line.startsWith('--- ')) {
        fullPath = line.substring(4).trim();
      } else {
        const parts = line.split(' ');
        fullPath = parts[parts.length - 1].substring(2).trim();
      }
      if (fullPath.startsWith('a/') || fullPath.startsWith('b/')) {
        fullPath = fullPath.substring(2);
      }
      const name = fullPath.split('/').pop() || fullPath;
      currentFile = {
        path: fullPath,
        name: name,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(currentFile);
    } else if (currentFile) {
      currentFile.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.removed++;
      }
    }
  }
  return files;
}

export function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'No project';
  return trimmed.split(/[\\/]/).pop() || 'No project';
}

export function fileNameFromPath(path) {
  const value = String(path || '');
  return value.split(/[\\/]/).pop() || value;
}

export function filesFromFileChangeTool(tool) {
  if (Array.isArray(tool.changes) && tool.changes.length > 0) {
    return tool.changes.map((change) => {
      const diffText = change.diff || '';
      const lines = diffText.split('\n');
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      return {
        path: change.path || '',
        name: fileNameFromPath(change.path),
        added,
        removed,
        lines,
      };
    });
  }
  return parseDiff(tool.text || '');
}
