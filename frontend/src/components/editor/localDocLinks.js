export function isLocalMarkdownSelfLink(label = '', href = '') {
  const name = String(label).trim();
  if (!/^[^\s/[\]()]+\.md$/i.test(name)) return false;

  try {
    const url = new URL(href);
    const isWebUrl = url.protocol === 'http:' || url.protocol === 'https:';
    const isBareHost = (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
    return isWebUrl && isBareHost && url.hostname.toLowerCase() === name.toLowerCase();
  } catch {
    return false;
  }
}

export function remarkPlainLocalDocSelfLinks() {
  return function transform(tree) {
    rewriteLocalDocLinks(tree);
  };
}

function rewriteLocalDocLinks(node) {
  if (!node || !Array.isArray(node.children)) return;

  node.children = node.children.map(child => {
    if (child.type !== 'link') {
      rewriteLocalDocLinks(child);
      return child;
    }

    const label = nodeText(child);
    if (!isLocalMarkdownSelfLink(label, child.url)) return child;
    return { type: 'text', value: `[${label}](${child.url})` };
  });
}

function nodeText(node) {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  if (!Array.isArray(node.children)) return '';
  return node.children.map(nodeText).join('');
}
