import { assistantApi } from './assistant.js';
import { automationApi } from './automation.js';
import { connectorsApi } from './connectors.js';
import { eventsApi } from './events.js';
import { projectsApi } from './projects.js';
import { runsApi } from './runs.js';
import { systemApi } from './system.js';
import { workApi } from './work.js';

export { ApiError } from './errors.js';
export { assistantApi } from './assistant.js';
export { automationApi } from './automation.js';
export { connectorsApi } from './connectors.js';
export { eventsApi } from './events.js';
export { projectsApi } from './projects.js';
export { runsApi } from './runs.js';
export { systemApi } from './system.js';
export { workApi } from './work.js';

/**
 * 旧 flat client 的兼容导出。
 *
 * 领域模块是唯一 source of truth；新调用方直接导入对应 `*Api`。兼容层直接引用
 * 同一批函数，不存在双读或双写。迁移窗口内如需回滚，调用方可重新导入这里或
 * `client.js`，不会改变请求行为；最终删除门禁是仓库内外调用方均完成迁移。
 */
export const api = {
  ...systemApi,
  ...projectsApi,
  ...workApi,
  ...runsApi,
  ...assistantApi,
  ...automationApi,
  ...connectorsApi,
  ...eventsApi,
};
