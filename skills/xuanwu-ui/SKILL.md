---
name: xuanwu-ui
description: 玄武前端极客设计系统规范（E2B 风格与电光赛博青）。用于玄武系统或需要 E2B 极客科技风的前端 UI 重构、新页面开发、组件设计及视觉验收。包含黑曜石暗黑底色、电光赛博青强调、单像素微边框、利落微圆角、纯净等宽无斜杠编号、HUD 监控与终端沙盒视窗组件规范。
---

# 玄武前端极客设计系统规范（Xuanwu Geek UI & Design System）

> **设计哲学**：
> **黑曜石深黑底色 · 电光赛博青单点强调 · 单像素微边框 · 纯净等宽无斜杠编号 · HUD 数据监控 · 沙盒终端视窗质感。**
> 
> 任何「大圆角、胶囊按钮、粗实线边框、大面积花哨渐变、厚重投影、白底弹窗」在本规范下**一律禁止**。

---

## 0. 快速唤醒指南

当需要在玄武项目或其他项目中执行前端 UI 改造或新功能开发时，调用方式：

```text
$xuanwu-ui 请遵循玄武极客设计系统规范，改造当前页面/组件，保持业务逻辑不变，完成明暗主题与响应式自查。
```

---

## 1. 核心设计准则 (Core Principles)

1. **黑曜石暗黑底色 (Obsidian Dark)**：主视口背景必须深邃沉浸（`#070709`），视窗与卡片采用二级暗黑色（`#0a0a0e`），顶栏与浮层为 `#0d0e12`，输入区与代码区下沉为深坑 `#060608`。
2. **唯一品牌强调色 (Cyber Cyan `#00e5ff`)**：除状态语义外，全局所有激活指示条、聚焦高亮、主按钮、光晕投影均统一使用电光赛博青，对比度高达 13:1，克制且极具科技辨识度。
3. **单像素微透明线 (1px Crisp Border)**：所有视窗容器、卡片、输入框、分割线均使用单像素微透明线（普通 `rgba(255, 255, 255, 0.08)` / 悬浮 `rgba(255, 255, 255, 0.16)`），杜绝任何粗实线或彩色厚边框。
4. **纯净等宽控制台编号 (Pure Monospace Naming)**：
   - 字体强制使用 JetBrains Mono 等宽字体。
   - 编号前缀采用**纯净无斜杠**排版规范：使用 `01 COMMAND_CENTER`、`02 ASK_XUANWU`、`01 看板`、`02 提问`。
   - **严格禁止出现 `//` 双斜杠**（例如严禁 `01 // 看板` 或 `02 // 提问`）。
5. **利落微圆角几何 (Sharp & Micro-Radius)**：
   - 按钮一律直角（`0px`）或 2px 微圆角；
   - 徽标、芯片、微标签统一采用 `2px`；
   - 视窗卡片、面板统一采用 `3px ~ 4px`；
   - 严格移除常规 UI 库的 `rounded-xl` / `rounded-2xl`，**严禁使用胶囊形状**（除 7px 圆形状态点外）。
6. **技术材质与网格底纹 (Tech Grid Texture)**：
   - 页面背景注入 32px 细腻微网格 (`.bg-grid-tech`)。
   - 滚动条采用极细暗黑半透明滑块（宽度 4~6px）。
7. **沙盒终端视窗与 HUD 监控质感**：
   - 页面主体内容置于沙盒视窗中，常驻 3 个微型指示圆点与等宽元数据标签。
   - 监控指标采用等宽大数字 + 细进度槽，呈现云原生沙盒监控仪表盘质感。

---

## 2. 颜色与材质令牌 (Design Tokens)

### 2.1 颜色令牌表

| 角色 / Token | 极客暗黑（DARK / E2B 主力） | 简洁浅色（LIGHT 备用） | Tailwind / CSS 用法 | 应用场景 |
|---|---|---|---|---|
| 画布底层 (`--bg-primary`) | `#070709` | `#f3efe5` | `bg-[#070709]` | 整个 Web 页面最底层画布背景 |
| 二级视窗 (`--bg-secondary` / `--bg-card`) | `#0a0a0e` | `#ece6d8` | `bg-[#0a0a0e]` | 内容面板、代码编辑器外框、监控卡片 |
| 视窗顶栏 (`--surface-raised`) | `#0d0e12` | `#faf7ee` | `bg-[#0d0e12]` | 终端视窗 Header、表格表头、浮层菜单 |
| 输入深坑 (`--control-bg`) | `#060608` | `#fffdf7` | `bg-[#060608]` | 表单 Input、Textarea、代码 pre 区域 |
| 品牌强调 (`--primary`) | `#00e5ff` (赛博青) | `#5b820a` (墨绿) | `text-[#00e5ff]`, `bg-[#00e5ff]` | 主操作按钮、聚焦边框、激活导航指示条 |
| 强调微光 (`--primary-glow`) | `rgba(0, 229, 255, 0.25)` | `rgba(91, 130, 10, 0.1)` | `shadow-[0_0_15px_rgba(0,229,255,0.25)]` | 强调按钮悬浮、激活微光外发光 |
| 主边框 (`--border-color`) | `rgba(255, 255, 255, 0.08)` | `#d9d2c0` | `border-white/[0.08]` | 极细 1px 单像素线，杜绝粗实线 |
| 弱边框 (`--border-light`) | `rgba(255, 255, 255, 0.04)` | `#e5dfcd` | `border-white/[0.04]` | 更弱的次级内部线条 |
| 悬浮边框 (`--border-color-hover`)| `rgba(255, 255, 255, 0.16)` | `#a9a189` | `border-white/[0.16]` | 卡片、按钮 hover 悬浮高亮边框 |
| 主正文 (`--text-primary`) | `#ffffff` | `#171a18` | `text-white` | 纯白强强调标题、等宽指标大数字 |
| 次级正文 (`--text-secondary`) | `#d4d4d8` | `#454c46` | `text-zinc-300` | 主正文、次级说明、列表项文字 |
| 辅助弱化 (`--text-muted`) | `#71717a` | `#79807a` | `text-zinc-500` | 等宽微标签、时间戳、占位符 |
| 最弱文本 (`--text-faint`) | `#52525b` | `#9aa099` | `text-zinc-600` | 弱化代码注释、最弱元数据 |
| 成功状态 (`--success`) | `#10b981` (翡翠绿) | `#15803d` | `text-emerald-500` | 运行正常、已完成、健康脉冲 |
| 警告状态 (`--warning`) | `#f59e0b` (琥珀黄) | `#b45309` | `text-amber-500` | 待人工审核、警告、中断 |
| 失败状态 (`--error`) | `#ef4444` (猩红) | `#b91c1c` | `text-red-500` | 运行异常、阻断、报错 |
| 运行状态 (`--info`) | `#06b6d4` (青蓝) | `#0369a1` | `text-cyan-500` | 运行中、任务派遣、调度事件 |

### 2.2 材质与微网格 CSS

```css
/* 32px 细腻微网格技术底纹 */
.bg-grid-tech {
  background-size: 32px 32px;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
}

/* 极细暗黑半透明滚动条 */
::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 229, 255, 0.35);
}
```

---

## 3. 几何与圆角规范 (Geometry & Radii)

严格禁止 `rounded-xl`、`rounded-2xl` 与 `rounded-full`（除状态圆点外）：

| 令牌 | 尺寸 | 应用构件 |
|---|---|---|
| `--button-radius` | `0px`（或 `rounded-[2px]`） | 所有操作按钮（主按钮、次级按钮、幽灵按钮） |
| `--radius-xs` | `2px` (`rounded-[2px]`) | 状态徽标、标签 chip、输入框 |
| `--radius-sm` | `4px` (`rounded-[4px]`) | 视窗卡片容器、Tabs 按钮、列表项、抽屉外框 |
| `--radius-md` | `6px` (`rounded-[6px]`) | 复杂多层视窗、模态对话框 |
| `--radius-lg` | `10px` (`rounded-[10px]`) | **唯一例外**：对话消息气泡 |

---

## 4. 字体排印与控制台命名规范 (Typography & Naming)

### 4.1 字体栈
- **等宽代码体**（核心辨识度）：`'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`。
- **通用正文**：`'Inter', -apple-system, 'Segoe UI', 'PingFang SC', sans-serif`。
- 所有数据指标、端口、哈希、路径、ID、开关状态、表格编码、标题微标签强制声明 `font-mono text-xs`。

### 4.2 纯净等宽命名规则（严禁使用 `//`）
开发者习惯采用清晰的纯净编号与元数据标签：

```text
规范命名示范：
✅ 01 看板
✅ 02 提问
✅ 03 任务
✅ 01 COMMAND_CENTER
✅ 02 ASK_XUANWU · Xuanwu assistant
✅ 03 WORK_LEDGER [BOARD: ACTIVE_TASKS]
✅ 04 RUN_INSPECTOR [TELEMETRY: RUNTIME]
✅ 05 AUTOMATION_LOOPS [DISPATCH: CRON_EVENTS]
✅ 06 TELEMETRY_ANALYTICS [METRICS: EVALUATION]
✅ SETTINGS · [SYS: PREFERENCES]

禁止反例：
❌ 01 // 看板        （严禁包含双斜杠 //）
❌ 02 // 提问        （严禁包含双斜杠 //）
❌ 01 // COMMAND_CENTER
```

---

## 5. 核心组件规范与代码模板 (Component Patterns)

### 5.1 沙盒控制台视窗 (Terminal Window)

```jsx
<div className="e2b-terminal-window bg-[#0a0a0e] border border-white/[0.08] rounded-[4px] overflow-hidden">
  {/* 视窗 Header Bar */}
  <div className="flex items-center justify-between px-3 py-2 bg-[#0d0e12] border-b border-white/[0.08]">
    <div className="flex items-center gap-2">
      {/* 3 个微型指示圆点 */}
      <span className="w-2 h-2 rounded-full bg-red-500/80 inline-block" />
      <span className="w-2 h-2 rounded-full bg-amber-500/80 inline-block" />
      <span className="w-2 h-2 rounded-full bg-emerald-500/80 inline-block" />
      <span className="font-mono text-xs font-semibold text-zinc-300 ml-1">01 COMMAND_CENTER</span>
    </div>
    <div className="font-mono text-[10px] text-zinc-500 uppercase tracking-wider">
      SANDBOX: ACTIVE · PID: 12048
    </div>
  </div>
  
  {/* 视窗内容区 */}
  <div className="p-4 bg-[#0a0a0e]">
    {/* 内容 */}
  </div>
</div>
```

### 5.2 主按钮与次级按钮 (Buttons)

```jsx
{/* 主操作按钮：青底黑字 + 直角 + 科技微光 */}
<button className="h-8 px-4 rounded-[2px] bg-[#00e5ff] text-[#070709] font-mono text-xs font-bold uppercase tracking-wider transition-all duration-150 hover:bg-[#33ebff] hover:shadow-[0_0_15px_rgba(0,229,255,0.35)] active:translate-y-px">
  EXECUTE_RUN
</button>

{/* 次级/幽灵按钮：深黑底 + 1px 单像素线 + 赛博青微字 */}
<button className="h-8 px-3 rounded-[2px] bg-[#0a0a0e] border border-white/[0.08] text-zinc-300 font-mono text-xs transition-all duration-150 hover:border-white/[0.2] hover:text-[#00e5ff]">
  EXPORT_LOGS
</button>
```

### 5.3 表单输入深坑 (Input Inset)

```jsx
<input 
  type="text" 
  placeholder="Filter by issue key or query..."
  className="h-8 w-full px-3 rounded-[2px] bg-[#060608] border border-white/[0.08] text-zinc-200 placeholder-zinc-600 font-mono text-xs transition-all duration-150 focus:outline-none focus:border-[#00e5ff] focus:shadow-[0_0_12px_rgba(0,229,255,0.2)]"
/>
```

### 5.4 HUD 监控指标槽 (HUD Telemetry Metric)

```jsx
<div className="bg-[#0a0a0e] border border-white/[0.08] p-3 rounded-[3px]">
  <div className="flex items-center justify-between mb-1">
    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">02 运行中任务</span>
    <span className="font-mono text-[11px] text-[#00e5ff]">RUNNING</span>
  </div>
  <div className="font-mono text-2xl font-bold text-white mb-2">03</div>
  {/* 极细指标进度槽 */}
  <div className="w-full h-1 bg-[#060608] rounded-[1px] overflow-hidden">
    <div className="h-full bg-[#00e5ff] rounded-[1px]" style={{ width: '45%' }} />
  </div>
</div>
```

### 5.5 侧边栏紧凑底部布局规范（防溢出）

在侧边栏（例如宽度约 200px~220px）的底部控制栏中，**严禁将 3 个以上按钮并排于单行**，必须遵循双行紧凑布局：

```jsx
{/* 底部控制区：第 1 行全宽统计分析，第 2 行设置 + 主题 */}
<div className="p-2 border-t border-white/[0.08] flex flex-col gap-1">
  {/* 第 1 行：统计分析独占全宽 */}
  <a href="/analytics" className="h-8 flex items-center gap-2 px-2.5 rounded-[2px] text-zinc-300 hover:bg-white/[0.05] hover:text-[#00e5ff] font-mono text-xs">
    <BarChart3 className="w-3.5 h-3.5 shrink-0" />
    <span className="truncate">06 分析</span>
  </a>

  {/* 第 2 行：设置（flex-1 伸缩）+ 主题切换按钮（紧凑方块 32x32） */}
  <div className="flex items-center gap-1">
    <a href="/settings" className="flex-1 min-w-0 h-8 flex items-center gap-2 px-2.5 rounded-[2px] text-zinc-300 hover:bg-white/[0.05] hover:text-[#00e5ff] font-mono text-xs overflow-hidden">
      <Settings className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">设置</span>
    </a>
    <button className="w-8 h-8 shrink-0 flex items-center justify-center rounded-[2px] border border-white/[0.08] bg-[#060608] text-zinc-400 hover:text-[#00e5ff] hover:border-white/[0.2]">
      <Sun className="w-3.5 h-3.5" />
    </button>
  </div>
</div>
```

---

## 6. 禁忌清单 (Forbidden Rules)

任何改动只要违反以下任意一条，即判定为**不合规**：

1. ❌ **严禁在标题或导航编号中使用 `//` 双斜杠**（必须是纯净等宽 `01 看板`、`01 COMMAND_CENTER`）。
2. ❌ **严禁使用 `rounded-xl` / `rounded-2xl` 或大胶囊按钮**（圆角上限 4px，气泡上限 10px）。
3. ❌ **严禁使用厚重渐变大色块或白底弹窗**（弹窗与卡片必须是 `#0a0a0e` 搭配单像素线）。
4. ❌ **严禁自行发明新主题色**（全局主强调色严格收敛为电光赛博青 `#00e5ff`）。
5. ❌ **严禁粗实线边框**（边框必须为 `1px` 微透明 `border-white/[0.08]`）。
6. ❌ **严禁 Emoji 作为业务图标**（强制使用 Lucide 线性图标，stroke-width 2）。
7. ❌ **严禁侧边栏底部多按钮单行强行并排导致溢出**。

---

## 7. 跨 Agent 重构 Prompt 模板 (Prompt Template)

当需要让其他 Agent（Codex / Claude Code / Cursor）协助改造新功能或新项目时，可直接发送以下 Prompt：

```markdown
请帮我把当前页面/组件重构为《玄武极客设计系统规范（E2B 风格与电光赛博青）》：

1. 色彩与材质：
   - 画布底层背景：黑曜石深黑 `#070709`（添加 32px 网格类 `.bg-grid-tech`）；
   - 二级卡片与面板：`#0a0a0e`，卡片顶栏：`#0d0e12`，输入区深坑：`#060608`；
   - 唯一品牌强调色：电光赛博青 `#00e5ff`，微光投影 `0 0 15px rgba(0, 229, 255, 0.25)`；
   - 边框与线条：极细单像素线 `border-white/[0.08]`，悬浮 `border-white/[0.16]`。

2. 几何与排版：
   - 按钮直角或 2px 微圆角；卡片与视窗统一 3px~4px 微圆角，禁止任何大圆角；
   - 字体以 JetBrains Mono 等宽为主，所有指标、标签、状态强制使用等宽；
   - 编号前缀采用纯净无斜杠格式（如 `01 看板`、`01 COMMAND_CENTER`），绝对不要出现 `//` 双斜杠。

3. 组件特征：
   - 卡片采用沙盒控制台视窗结构，顶部包含 Header Bar 与三色呼吸指示点；
   - 输入框底色为 `#060608`，聚焦时赛博青 1px 细线边框与微光；
   - 指标卡采用 HUD 大数字 + 细进度槽。

4. 约束：
   - 保持全部原有业务逻辑与交互事件不变；
   - 构建与测试 0 错误通过。
```
