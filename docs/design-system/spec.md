# Xuanwu 前端设计规范

> 本文件是仓库内所有前端 UI 的**唯一权威规范**。本目录 `docs/design-system/` 内：
> `tokens.css` 提供可直接引入的全部 CSS 变量；`components.css` 提供全部标准组件的参考实现；
> `examples/` 提供浏览器可直接打开的 HTML 示例。三者与本文件构成不可分割的整体。

---

## 0. 设计哲学

系统同时提供两种主题，共享**同一套几何与排版骨架**，只切换配色：

- **简洁（LIGHT）**：米白纸面 `#f3efe5` + 墨绿强调 `#5b820a`。安静、留白、像一份排版良好的技术文档。
- **极客（DARK）**：纯黑 `#070a0a` + 荧光绿 `#baff3f`。终端感、高对比、等宽字体微标签。

无论哪个主题，以下五条不可违背：

1. **方形几何**：直角或 2–6px 微圆角；按钮一律直角。
2. **等宽字体微标签**：所有标签、徽标、元数据用 JetBrains Mono、大写、宽字距、极小字号。
3. **单点强调**：一个视口内只有一处荧光强调（通常是主按钮或当前态）；其余保持墨色/灰阶。
4. **细线分割，不用色块堆叠**：区块之间用 1px 细线（`--border-color`）分开；**禁止**用大面积彩色卡片铺满页面。
5. **克制的动效**：只在状态变化和 hover/focus 上有 120–180ms 的轻过渡，加 status-dot 脉冲、转圈 loading，仅此而已。

---

## 1. 色彩令牌

**所有组件颜色一律引用 CSS 变量，禁止在组件规则中写死 hex。** 颜色值只允许出现在令牌定义中；切换主题只改 `:root` / `[data-theme="dark"]` 上的变量值，组件代码不动。

### 1.1 背景 / 表面

| 令牌 | 简洁（LIGHT） | 极客（DARK） | 用途 |
|---|---|---|---|
| `--bg-primary` | `#f3efe5` | `#070a0a` | 页面底层 |
| `--bg-secondary` | `#ece6d8` | `#0c100f` | 次层背景、Tab 条 |
| `--bg-card` | `rgba(255,253,247,.88)` | `rgba(19,24,22,.9)` | 卡片/面板底 |
| `--surface-raised` | `#faf7ee` | `#101514` | 凸起小面（工具卡、starter 卡） |
| `--surface-overlay` | `#fffdf7` | `#131816` | 下拉、浮层 |
| `--nav-hover` | 主色 4% 透明 | 主色 6% 透明 | 列表 hover |
| `--nav-active` | 主色 8% 渐变 | 主色 12% 渐变 | 列表 active |

### 1.2 文字

| 令牌 | 简洁 | 极客 | 用途 |
|---|---|---|---|
| `--text-primary` | `#171a18` | `#e2e7e4` | 标题、正文 |
| `--text-secondary` | `#454c46` | `#a4aca6` | 次级说明 |
| `--text-muted` | `#79807a` | `#646b66` | 微标签、占位、时间戳 |
| `--text-faint` | `#9aa099` | `#464c48` | 最弱提示 |

### 1.3 强调与功能色

| 令牌 | 简洁 | 极客 | 用途 |
|---|---|---|---|
| `--primary` | `#5b820a` | `#baff3f` | **唯一品牌强调** |
| `--primary-hover` | `#6e9a10` | `#cdff70` | hover |
| `--primary-glow` | 墨绿 10% | 荧光绿 12% | 强调面浅底、图标芯片底 |
| `--success` | `#15803d` | `#4ade80` | 成功 |
| `--warning` | `#b45309` | `#fbbf24` | 警告/中断 |
| `--error` | `#b91c1c` | `#f87171` | 失败/危险 |
| `--info` | `#0369a1` | `#38bdf8` | 运行中/信息 |

### 1.4 主按钮（品牌按钮）

| 令牌 | 简洁 | 极客 |
|---|---|---|
| `--button-primary-bg` | `#0a0d0c`（近黑） | `#baff3f`（荧光绿） |
| `--button-primary-fg` | `#f2f5f0`（米白） | `#0a0d0c`（近黑） |

> 浅色主题下主按钮是**黑底白字**（不是绿底）；深色主题下是**绿底黑字**。这是两个主题各自的「单点强调」，不得互换。

### 1.5 边框

| 令牌 | 简洁 | 极客 | 用途 |
|---|---|---|---|
| `--border-color` | `#d9d2c0` | `#222826` | 标准 1px 分割 |
| `--border-light` | `#e5dfcd` | `#181d1b` | 更弱的分割 |
| `--border-color-hover` | `#a9a189` | `#3a423e` | hover 加深 |

---

## 2. 圆角令牌

**只允许以下五档，禁止其他值。**

| 令牌 | 值 | 用途 |
|---|---|---|
| `--button-radius` | `0px` | **所有按钮一律直角** |
| `--radius-xs` | `2px` | 徽标、选择器 chip、小标签 |
| `--radius-sm` | `4px` | 图标按钮、列表项、Tab |
| `--radius-md` | `6px` | 卡片、starter 卡、浮层 |
| `--radius-lg` | `10px` | 唯一例外：对话气泡（仅气泡用） |

**禁止**：`border-radius >= 999px` 的胶囊（status-dot 圆点除外）、任何 > 10px 的圆角。

---

## 3. 字体与字号

### 3.1 字族

| 令牌 | 值 | 用途 |
|---|---|---|
| `--font-display` | `'Inter', -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif` | 标题、正文、按钮 |
| `--font-mono` | `'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace` | **微标签、徽标、元数据、代码、数字、状态** |

### 3.2 字阶（只许用这几档）

| 档位 | 大小 | 用途 |
|---|---|---|
| 微标签 | `0.52rem – 0.62rem` | mono、大写、`letter-spacing .06–.16em`、`font-weight 750–800`。如 `PROVIDER`、`TOKENS`、`NEW PROVIDER SESSION` |
| 辅助说明 | `0.66rem – 0.72rem` | 次要说明、placeholder、时间戳 |
| 正文 | `0.78rem – 0.95rem` | 正文、按钮文字、列表项标题 |
| 输入器 | `0.95rem – 1rem` | composer 正文 |
| 区块标题 | `1rem – 1.2rem` | 面板/卡片标题 |
| 页面标题 | `1.4rem – 2rem` | `clamp(1.4rem, 3vw, 2rem)`，`font-weight 650`，`letter-spacing -0.02em` |

### 3.3 微标签范式（高频复用）

```css
.label {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.56rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
```

任何「PROVIDER」「ATTEMPTS」「TOKENS」这类字段标签都必须长这样。**页面里几乎不应该出现没有大写 + 宽字距的 mono 小标签。**

---

## 4. 间距与布局

- **基础单位 4px**：内边距/外边距只用 `4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32`。
- 面板/卡片内边距：`14px – 18px`；页面级 gutter：`18px – 24px`（移动端 `12px`）。
- 区块之间**用 1px `--border-color` 细线分割**，不用卡片套卡片。
- 列表项之间 `gap: 4px – 6px`；面板内部元素 `gap: 8px – 12px`。
- 阅读宽度上限：对话正文 `--content-max-width: 900px`、消息 `--sessions-message-max-width: 1120px`；输入器最大 720–780px。
- 阴影只允许极轻：`0 1px 2px rgba(0,0,0,.04)` 或 `0 12px 32px -18px rgba(0,0,0,.12)`；**禁止**厚重投影。

### 4.1 玻璃拟态（仅限三处）

以下三类**固定容器**允许使用毛玻璃：

```css
.glass {
  background: color-mix(in srgb, var(--bg-primary) 86%, transparent);
  backdrop-filter: saturate(140%) blur(12px);
  border-bottom: 1px solid var(--border-light);
}
```

仅限：① 主侧边栏；② 页面头部（header/topbar）；③ 对话输入器（composer）。**内容区、卡片、面板一律不用 blur。**

---

## 5. 组件规范

> 以下每个组件在 `components.css` 中有完整参考实现，在 `examples/index.html` 中有可视化示例。**写组件前先查这里，禁止自行发明变体。**

### 5.1 按钮

- **直角**（`border-radius: var(--button-radius)` = 0），**等高 32px**（小档 28px），`font-size 0.78rem`、`font-weight 600`、`letter-spacing 0.01em`。
- **primary**：`--button-primary-bg` / `--button-primary-fg`，hover 用 `--primary-hover` 与对应前景。**不加投影、不加渐变、不加边框。**
- **ghost/secondary**：透明底 + `1px solid var(--border-color)`，hover 时 `background: var(--nav-hover)` + `border-color: var(--border-color-hover)`。
- **danger**：error 色文字 + error 边框；danger-primary 才用 error 实底。
- **icon 按钮**：`28×28`，`var(--radius-sm)`，透明底，图标 14–15px（stroke-width 2），hover 同上。
- **加载态**：左侧 12px 转圈（`border-top-color: currentColor` 的 spinner），文案不变。
- **禁止**：圆角按钮、渐变按钮、带阴影按钮、图标+文字混排时图标大小超过文字 1.2 倍。

### 5.2 输入器（Composer）

对话/任务的输入器是系统核心组件：

- 外壳：`var(--bg-card)` 底、`1px solid var(--border-color)`、`var(--radius-lg)`（输入器是除气泡外唯一允许 10px 的组件）、focus-within 时 `border-color: var(--primary)` + `box-shadow: 0 0 0 3px var(--primary-glow)`。
- textarea：无背景无边框，`font-size 0.95rem`，`min-height` 对话页 96px、新建页 110px。
- footer 内嵌控件（模型/策略选择）：`composer-embedded-select`——`var(--control-bg)` 底、`var(--radius-xs)`、mono `0.72rem`。
- 提交按钮：圆形 `34×34` 是**唯一例外**（传承自会话输入器的历史组件），实底主色，禁用态 `--bg-card-hover`。
- 输入器上方允许有一条「运行态 pill」：`runtime-status-pill`。

### 5.3 Tabs（区块切换）

- 容器：顶部细线分割的通栏条（`border-bottom: 1px solid var(--border-color)`），**不要做成漂浮的大胶囊**。
- 按钮：`var(--radius-xs)`、大写、`letter-spacing 0.045em`、`font-size 0.68rem`；hover `var(--nav-hover)`；**active = `--button-primary-bg` 实底**。
- 列表型 Tab（如 Attempt 列表）：active 用 `inset 0 -2px 0 var(--primary)` 下划线 + `var(--bg-card)` 底。

### 5.4 侧边栏列表项

- 默认透明底；hover `var(--nav-hover)`；active `var(--nav-active)` + `inset 2px 0 0 var(--primary)` 左侧色条 + `1px` 主色 20% 边。
- 列表项内标题 `0.78rem / 600`，元数据行 mono `0.58rem` muted。
- 「新建」入口按钮（如 New Chat）：主色渐变底（`linear-gradient(135deg, var(--primary), var(--primary-hover))`）——**这是全系统唯一允许渐变的按钮**。

### 5.5 状态标记（Pill / Dot）

- **status-dot**：`7×7` 圆点（唯一允许 `border-radius: 50%` 的元素），配 mono `0.62rem` 大写文字；运行中给 1.4s 脉冲 + `0 0 0 3px var(--primary-glow)` 光晕。
- **status-pill**：`var(--radius-xs)`、mono 大写、`0.56rem`、带 1px 同色透明边与 8% 同色底；运行中脉冲的是 dot 不是整个 pill。
- 状态色映射：`running/created → info`、`succeeded → success`、`failed → error`、`interrupted → warning`、`idle → muted`。

### 5.6 数据事实条（Fact Strip）

键值对横排（Provider / Status / Tokens / Cost），用于详情页头部：

- 每个 fact 是**纵向**结构：上 `small`（mono 大写 0.56rem muted）下 `strong`（mono `0.78rem` 主文字色）。
- fact 之间用 `border-right: 1px solid var(--border-light)` 分隔，不用卡片包裹。
- Status 值按状态着色。

### 5.7 消息气泡

- 用户气泡：`--primary-glow` 底、`var(--radius-lg)`（气泡专属）、`align-self: flex-end`、最大宽 80%。
- 助手消息：**不用气泡**——左侧 `26×26` 方形头像（`--primary-glow` 底 + 主色图标），右侧纯文本直接排在内容流里。
- 气泡头部：头像 + mono 大写角色名（`0.6rem`）。
- 错误/中断：`--error` 色系，左侧 error 色边条。

### 5.8 终端 / 工具输出

- 终端卡：固定 `--terminal-bg` 深底、等宽字体、`var(--radius-md)`、头部一条 `mono 0.6rem` 标题栏；文本与语义色同样使用 `--terminal-*` 令牌。
- 工具调用卡：`--surface-raised` 底、1px 边、`var(--radius-md)`、头部左侧 mono 图标 + 名称，右侧状态 pill；body 默认折叠。
- 会话执行过程：实时与历史详情均默认折叠，用户展开/收起后不因新事件改变选择。实时状态与详情入口合并为一条透明底、细线分隔的摘要，只保留一个 spinner；不再叠加 working 横幅、Streaming 徽标或思考占位动效。错误与待审批直接显示在摘要中并停止转圈，错误文案允许换行，不能藏在折叠详情内。

### 5.9 空状态 / 加载

- 空状态：居中，34px 线性图标（muted 色）+ 一句 `0.8rem` 说明 + 可选 starter 按钮组；**禁止插画、禁止大图**。
- 加载：TurtleLoader（品牌）或 14px spinner + muted 文案；页面级骨架用 1px 线的浅底块，不用闪屏大色块。

---

## 6. 动画规范

**原则：只有状态变化和 hover/focus 配动效，时长 120–180ms，仅作用于 `opacity / transform / background-color / border-color`。**

| 场景 | 规范 |
|---|---|
| hover / focus | `transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease`；**不加 transform 位移**（icon 按钮除外，可 translateY(-0.5px)） |
| 页面/卡片进入 | `fadeUp`: `opacity 0→1, translateY(6px)→0`，`220ms cubic-bezier(.16,1,.3,1)`，仅首屏一次 |
| 状态点脉冲 | `pulse`: `opacity .45→1→.45`，`1.4s ease-in-out infinite`，仅用于 running |
| 加载转圈 | `spin 1s linear infinite`，12–14px、2px 边框、`border-top-color: currentColor` |
| 面板展开/折叠 | `max-height` 或 grid-rows 过渡 ≤ 200ms；**禁止** scale 缩放 |
| **禁止** | 弹跳 ease（bounce/elastic）、多元素级联延迟、hover 放大阴影、任何 > 300ms 的过渡、`transform: scale` 强调 |

---

## 7. 图标

- 只用 **lucide**（React 用 `lucide-react`，静态 HTML 用内联 SVG 同 path），stroke-width 2。
- 尺寸档：`13 / 14 / 15 / 16 / 34`（空状态）。按钮内图标 13–14px，与文字间距 `gap: 6px`。
- **禁止 emoji 当图标**、禁止彩色填充图标、禁止混用图标库。

---

## 8. 文案与语言

- 产品名「玄武」，页面标题等用户可见文案用简体中文；标识符、状态枚举、日志保留英文原文。
- 微标签用英文大写（`PROVIDER`、`ATTEMPTS`）；说明句用中文。
- 按钮文案 2–6 个字，动词开头（`发送`、`新建会话`、`中断`）。

---

## 9. 响应式

- 断点：`980px`（折叠侧栏）、`760px`（单列化）、`680px`（starter 卡单列）。
- 移动端 gutter 收到 `12px`；fact 条允许换行；Tabs 允许横向滚动（`scrollbar-width: none`）。
- **禁止**在移动端把卡片放大成大圆角 containment——几何语言全端一致。

---

## 10. 禁忌清单（违反任意一条即不合规）

1. ❌ `border-radius >= 999px` 的胶囊按钮 / 大胶囊 Tab / 大胶囊输入框（status-dot、composer 提交钮除外）。
2. ❌ 任何 > 10px 的圆角。
3. ❌ 大面积彩色卡片铺满内容区；卡片套卡片。
4. ❌ 硬编码颜色 hex / rgb（必须走 `var(--*)`）；为暗色主题写独立硬编码覆盖。
5. ❌ 厚重投影、`box-shadow` 大于规范档。
6. ❌ 渐变按钮（除「新建」入口的唯一品牌渐变）、渐变背景大块使用。
7. ❌ emoji 当图标；混用图标库。
8. ❌ 正文超过 1rem、页面标题超过 2rem、出现非规范档字号。
9. ❌ 微标签不用 mono / 不大写 / 不加宽字距。
10. ❌ hover 位移动画（除 icon 按钮 -0.5px）、scale 动画、>300ms 过渡、级联延迟。
11. ❌ 玻璃拟态用在内容卡片上。
12. ❌ 出现设计规范之外的新强调色。

---

## 11. 验收 Checklist

提交前端改动前逐条自查：

- [ ] 所有颜色/圆角/字号/间距均来自 `tokens.css` 变量，无硬编码。
- [ ] 按钮直角；组件圆角 ≤ 6px（气泡/输入器 10px）；无胶囊。
- [ ] 所有标签/徽标/元数据为 mono + 大写 + 宽字距。
- [ ] 页面只有一处主色强调；主按钮浅主题黑底、深主题绿底。
- [ ] 区块分割用 1px 细线，没有色块堆叠。
- [ ] 动效 ≤180ms 且仅 opacity/transform/颜色；loading 用转圈或脉冲点。
- [ ] 图标全部 lucide、stroke 2、规范尺寸。
- [ ] 明暗两主题均目检通过（对照 `examples/index.html`）。
- [ ] 移动端 760px 下单列、几何语言不变。
