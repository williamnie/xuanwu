import { readFileSync } from 'node:fs';

// 只读取 App 本身的拆分边界，避免把页面依赖混进路由和生命周期合同。
export function readAppSource() {
  return ['App.jsx', 'useAppNavigation.js', 'useAppReconciliation.js', 'useMobileSidebar.js']
    .map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n');
}
