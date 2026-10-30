import { readFileSync, readdirSync } from 'node:fs';

const sourceRoot = new URL('../src/', import.meta.url);
const importPattern = /@import\s+['"]([^'"]+)['"]\s*;/g;

// 按浏览器级联顺序展开本地片段；规范令牌仍由仓库外的唯一源文件负责。
export function readStylesheet(url, encoding = 'utf8', ancestors = new Set()) {
  if (ancestors.has(url.href)) throw new Error(`Circular stylesheet import: ${url.href}`);
  const next = new Set([...ancestors, url.href]);
  return readFileSync(url, encoding).replace(importPattern, (statement, path) => {
    const target = new URL(path, url);
    return target.href.startsWith(sourceRoot.href) ? readStylesheet(target, encoding, next) : statement;
  });
}

// 每份入口及其导入片段共同接受原有精确选择器合同；未被导入的新文件也必须检查。
export function readStyleSources(root = sourceRoot) {
  const files = readdirSync(root, { recursive: true }).filter(path => path.endsWith('.css'));
  const imported = new Set();
  for (const path of files) {
    const url = new URL(path, root);
    for (const [, relative] of readFileSync(url, 'utf8').matchAll(importPattern)) {
      imported.add(new URL(relative, url).href);
    }
    // 同时检查所有文件的导入图，不能让闭环从入口扫描中消失。
    readStylesheet(url);
  }
  return Object.fromEntries(files.filter(path => !imported.has(new URL(path, root).href))
    .map(path => [path, readStylesheet(new URL(path, root))]));
}
