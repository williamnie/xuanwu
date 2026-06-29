from html import escape
from pathlib import Path

W, H = 2800, 1650
OUT = Path('output/architecture/codex-issue-runner-architecture.svg')

BG = '#041021'
PANEL = '#0a1a32'
PANEL2 = '#0e203c'
TEXT = '#edf7ff'
MUTED = '#9fb6d8'
CYAN = '#00e5ff'
BLUE = '#3c8bff'
GREEN = '#39ff88'
MAGENTA = '#ff2fb3'
YELLOW = '#ffd84a'
PURPLE = '#a855ff'
ORANGE = '#ff9f1a'


def E(s):
    return escape(str(s), quote=True)


def text(x, y, content, size=28, color=TEXT, weight=500, family="var(--font-body)", anchor='start', opacity=1, extra=''):
    return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}" font-family="{family}" text-anchor="{anchor}" opacity="{opacity}" {extra}>{E(content)}</text>'


def multi_text(x, y, lines, size=24, color=MUTED, weight=400, gap=34, family="var(--font-body)"):
    out=[]
    for i, line in enumerate(lines):
        out.append(text(x, y + i*gap, line, size=size, color=color, weight=weight, family=family))
    return '\n'.join(out)


def rounded_rect(x,y,w,h, fill=PANEL, stroke='#214264', sw=2, r=24, opacity=1, extra=''):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def item_box(x,y,w,h,title,desc,accent=CYAN):
    return f'''
    <g>
      <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="#07172c" stroke="{accent}" stroke-opacity="0.34" stroke-width="1.6"/>
      <rect x="{x}" y="{y}" width="4" height="{h}" rx="2" fill="{accent}" opacity="0.9"/>
      {text(x+22,y+34,title,24,TEXT,700)}
      {text(x+22,y+66,desc,18,MUTED,420)}
    </g>'''


def card(x,y,w,h,num,title,subtitle,items,accent=CYAN):
    out=[f'<g class="card">']
    out.append(rounded_rect(x,y,w,h,fill='#07172e',stroke=accent,sw=2,r=26,opacity=0.88,extra='filter="url(#cardShadow)"'))
    out.append(f'<circle cx="{x+45}" cy="{y+48}" r="25" fill="url(#{accent_name(accent)}Grad)" filter="url(#softGlow)"/>')
    out.append(text(x+45,y+57,str(num),26,'#ffffff',800,anchor='middle',family='var(--font-mono)'))
    out.append(text(x+82,y+50,title,29,TEXT,800,family='var(--font-display)'))
    out.append(text(x+82,y+82,subtitle,18,MUTED,500))
    # tiny circuit line
    out.append(f'<line x1="{x+24}" y1="{y+108}" x2="{x+w-24}" y2="{y+108}" stroke="{accent}" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="7 9"/>')
    iy=y+132
    box_h=74
    for t,d in items:
        out.append(item_box(x+24,iy,w-48,box_h,t,d,accent))
        iy += box_h + 18
    out.append('</g>')
    return '\n'.join(out)


def accent_name(c):
    return {
        CYAN:'cyan', BLUE:'blue', GREEN:'green', MAGENTA:'magenta', YELLOW:'yellow', PURPLE:'purple', ORANGE:'orange'
    }.get(c,'cyan')

cards = [
    (70, 335, 320, 570, 1, 'INPUT SURFACES', '需求入口 / 人机界面', [
        ('Web Dashboard', '项目、Issue、Session 看板'),
        ('CLI + Codex Skill', '创建 / 查询 / 重试 / 完成'),
        ('Feishu IM', '群聊指令、卡片审批、通知'),
        ('Cron / External Events', '定时 triage 与外部事件接入'),
        ('Provider Sessions', '手动会话与 issue 执行共用追踪'),
    ], CYAN),
    (414, 335, 340, 570, 2, 'RUNNER CORE', 'Bun API + SQLite', [
        ('Projects / Issues API', '自建队列、状态机与写接口'),
        ('Auto-run Loops', 'todo claim、并发控制、hold'),
        ('SQLite runner.db', '持久化项目 / runs / events'),
        ('Global SSE', '/api/events 实时推送'),
        ('Auth + Origin Guard', 'Bearer token 与本机 origin 边界'),
    ], BLUE),
    (778, 335, 390, 570, 3, 'CODEX PROVIDER', 'app-server stdio JSON-RPC', [
        ('Lazy Runtime', '按需启动 codex app-server'),
        ('Thread / Turn', 'thread/start · turn/start · resume'),
        ('Approvals / Interrupt', '权限请求、人工审批、中断'),
        ('Runtime Settings', 'model / reasoning / sandbox 记录'),
        ('Session Transcript', '会话、命令、事件可回放'),
    ], PURPLE),
    (1192, 335, 350, 570, 4, 'EXECUTION LOOP', '执行、验证与交付', [
        ('Per-issue Session', '每个 issue 绑定独立上下文'),
        ('Workspace Scoped', '按项目 cwd 执行，隔离上下文'),
        ('Logs + Artifacts', 'stdout、事件、引用与产物'),
        ('Verification Gate', '验证证据不足不算 done'),
        ('Explicit Update', 'agent 通过 CLI/API 回写状态'),
    ], GREEN),
    (1566, 335, 360, 570, 5, 'PI CONTROL PLANE', '个人工程助理控制台', [
        ('Chat Orchestration', 'Feishu / Web 对话式调度'),
        ('Policy Editor', '项目策略、权限、预算配置'),
        ('Memory + Skills', '项目记忆、skill、MCP 工具'),
        ('Delegations + Reports', '委派、报告、运行摘要'),
        ('Provider Settings', 'Codex / Claude 等运行配置'),
    ], MAGENTA),
    (1950, 335, 360, 570, 6, 'GUARDIAN LAYER', '守护、恢复、通知', [
        ('Supervisor', '卡住 / 无进展 / 异常诊断'),
        ('Watchdog', '长时间挂起与失败巡检'),
        ('Recovery Planner', '重试、恢复预算、退避策略'),
        ('Digest Routing', 'quiet / digest / urgent 分流'),
        ('Feishu Outbox', '通知草稿、审批卡片、回执'),
    ], ORANGE),
    (2334, 335, 396, 570, 7, 'OPERATOR SURFACES', '运维与可观测入口', [
        ('/health', '免鉴权健康检查'),
        ('/api/system/status', 'DB / runner / provider 摘要'),
        ('/api/system/doctor', '运行时 doctor / 诊断'),
        ('Dashboard / Sessions', '用量、会话、命令、审批'),
        ('redeploy.sh + launchd', '本机后台服务与验活脚本'),
    ], CYAN),
]

# bottom layers helpers
bottom_cols = [
    ('runner.db', 'projects · issues · runs · sessions', BLUE),
    ('Event Stream', 'issue_events · SSE · audit trail', CYAN),
    ('Policy State', 'PI policy · approval · recovery budget', MAGENTA),
    ('Notification Intent', 'digest · lifecycle · Feishu outbox', ORANGE),
    ('Usage + Logs', 'token usage · launchd logs · doctor', GREEN),
]
trust_cols = [
    ('Local-first', '自托管、本机 / 局域网优先'),
    ('Persistent', '重启后仍能恢复状态与审计'),
    ('Human Gate', '高风险动作可审批、可拒绝'),
    ('Agent Boundaries', 'agent 不直接碰 DB，只走 API/CLI'),
    ('Evidence-driven', '完成前要求验证与明确状态回写'),
]

svg=[]
svg.append(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <style>
    :root {{ --font-display: 'DIN Alternate', 'Hiragino Sans GB', 'PingFang SC', 'Arial Unicode MS', sans-serif; --font-body: 'Hiragino Sans GB', 'PingFang SC', 'Arial Unicode MS', sans-serif; --font-mono: 'SF Mono', 'Menlo', 'PT Mono', monospace; }}
    .micro {{ letter-spacing: 6px; }}
    .title {{ letter-spacing: 1.5px; }}
    .card text {{ paint-order: stroke; stroke: rgba(4,16,33,0.14); stroke-width: 1px; }}
  </style>
  <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#020816"/>
    <stop offset="45%" stop-color="#07172f"/>
    <stop offset="100%" stop-color="#030714"/>
  </linearGradient>
  <radialGradient id="halo1" cx="18%" cy="8%" r="58%"><stop offset="0%" stop-color="#0a78ff" stop-opacity="0.45"/><stop offset="100%" stop-color="#0a78ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="halo2" cx="88%" cy="18%" r="58%"><stop offset="0%" stop-color="#ff2fb3" stop-opacity="0.25"/><stop offset="100%" stop-color="#ff2fb3" stop-opacity="0"/></radialGradient>
  <linearGradient id="cyanGrad" x1="0" x2="1"><stop offset="0" stop-color="#00f5ff"/><stop offset="1" stop-color="#2f80ff"/></linearGradient>
  <linearGradient id="blueGrad" x1="0" x2="1"><stop offset="0" stop-color="#3c8bff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
  <linearGradient id="greenGrad" x1="0" x2="1"><stop offset="0" stop-color="#39ff88"/><stop offset="1" stop-color="#00d4a6"/></linearGradient>
  <linearGradient id="magentaGrad" x1="0" x2="1"><stop offset="0" stop-color="#ff2fb3"/><stop offset="1" stop-color="#a855ff"/></linearGradient>
  <linearGradient id="yellowGrad" x1="0" x2="1"><stop offset="0" stop-color="#ffd84a"/><stop offset="1" stop-color="#ff9f1a"/></linearGradient>
  <linearGradient id="purpleGrad" x1="0" x2="1"><stop offset="0" stop-color="#a855ff"/><stop offset="1" stop-color="#3c8bff"/></linearGradient>
  <linearGradient id="orangeGrad" x1="0" x2="1"><stop offset="0" stop-color="#ff9f1a"/><stop offset="1" stop-color="#ff3d71"/></linearGradient>
  <filter id="softGlow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000" flood-opacity="0.42"/></filter>
  <filter id="textGlow" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <pattern id="grid" width="52" height="52" patternUnits="userSpaceOnUse"><path d="M 52 0 L 0 0 0 52" fill="none" stroke="#1c3e65" stroke-opacity="0.22" stroke-width="1"/></pattern>
  <marker id="arrow" markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto" markerUnits="strokeWidth"><path d="M2,2 L12,7 L2,12" fill="none" stroke="#00e5ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>

<rect width="{W}" height="{H}" fill="url(#bgGrad)"/>
<rect width="{W}" height="{H}" fill="url(#halo1)"/>
<rect width="{W}" height="{H}" fill="url(#halo2)"/>
<rect x="0" y="0" width="{W}" height="{H}" fill="url(#grid)" opacity="0.48"/>
<path d="M-120 1260 C 560 1120, 970 1420, 1580 1260 S 2390 1010, 2960 1180" stroke="#00e5ff" stroke-opacity="0.08" stroke-width="90" fill="none"/>
<path d="M-60 1050 C 650 900, 1010 1040, 1500 930 S 2280 770, 2880 860" stroke="#ff2fb3" stroke-opacity="0.06" stroke-width="80" fill="none"/>
''')

# top micro status bar
svg.append(rounded_rect(80,48,2640,38,fill='#031528',stroke=CYAN,sw=1,r=0,opacity=0.62))
svg.append(text(110,74,'● SYS::ONLINE   //   codex-issue-runner · local AI engineering ops architecture',20,CYAN,700,family='var(--font-mono)',extra='class="micro"'))
svg.append(text(2700,74,'BUILD 2026.06.22',20,GREEN,700,family='var(--font-mono)',anchor='end',extra='class="micro"'))

# Logo block
svg.append(f'<g transform="translate(110,112)"><rect x="0" y="0" width="112" height="112" rx="28" fill="#07172e" stroke="{CYAN}" stroke-width="4" filter="url(#softGlow)"/><path d="M30 37 L56 56 L30 75" fill="none" stroke="{CYAN}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 76 L86 76" stroke="{GREEN}" stroke-width="8" stroke-linecap="round"/></g>')
svg.append(text(250,162,'CODEX ISSUE RUNNER',66,TEXT,900,family='var(--font-display)',extra='class="title" filter="url(#textGlow)"'))
svg.append(text(252,214,'LOCAL AI ENGINEERING OPS CONTROL PLANE',28,CYAN,800,family='var(--font-mono)',extra='class="micro"'))
svg.append(text(252,260,'自托管 Issue 执行平台  ·  Codex Provider Sessions  ·  PI Guardian  ·  Feishu 审批通知  ·  Verification Gate',26,MUTED,520))

# badges
def badge(x,y,label,accent):
    w = 26*len(label) + 48
    return f'<g><rect x="{x}" y="{y}" width="{w}" height="44" rx="22" fill="#06162b" stroke="{accent}" stroke-opacity="0.72"/><circle cx="{x+24}" cy="{y+22}" r="7" fill="{accent}"/>{text(x+44,y+30,label,20,TEXT,700)}</g>'

badges=[('Bun API Server',CYAN),('SQLite Persistent State',BLUE),('Codex app-server',PURPLE),('Feishu IM / Cards',MAGENTA),('Local-first Ops',GREEN)]
bx=250
for label,acc in badges:
    svg.append(badge(bx,282,label,acc))
    bx += 26*len(label)+70

# Main cards
for c in cards:
    svg.append(card(*c))

# arrows between cards
for ax in [392,756,1170,1544,1928,2312]:
    svg.append(f'<path d="M{ax} 610 L{ax+38} 610" stroke="{CYAN}" stroke-width="5" stroke-linecap="round" marker-end="url(#arrow)" filter="url(#softGlow)" opacity="0.92"/>')

# data rail
rail_y=950
svg.append(f'<line x1="180" y1="{rail_y}" x2="2620" y2="{rail_y}" stroke="{CYAN}" stroke-width="3" stroke-dasharray="10 14" stroke-opacity="0.55"/>')
for x in [230,584,973,1368,1746,2130,2530]:
    svg.append(f'<circle cx="{x}" cy="{rail_y}" r="9" fill="{CYAN}" filter="url(#softGlow)"/>')
    svg.append(f'<line x1="{x}" y1="905" x2="{x}" y2="{rail_y}" stroke="{CYAN}" stroke-width="3" stroke-opacity="0.48"/>')
svg.append(text(W/2,940,'STATE · CONTROL · VISIBILITY',28,CYAN,800,family='var(--font-mono)',anchor='middle',extra='class="micro"'))

# persistent control layer
svg.append(rounded_rect(120,990,2560,245,fill='#07172e',stroke=CYAN,sw=2,r=28,opacity=0.76,extra='stroke-dasharray="10 12"'))
svg.append(text(W/2,1039,'PERSISTENT CONTROL LAYER / 状态、审计与可恢复性',31,CYAN,850,family='var(--font-display)',anchor='middle',extra='class="micro"'))
col_w=480
start_x=185
for i,(title,desc,acc) in enumerate(bottom_cols):
    x=start_x+i*500
    svg.append(f'<g><rect x="{x}" y="1080" width="440" height="112" rx="18" fill="#051226" stroke="{acc}" stroke-opacity="0.42"/>')
    # icon mini
    svg.append(f'<rect x="{x+24}" y="1111" width="52" height="52" rx="12" fill="{acc}" fill-opacity="0.15" stroke="{acc}" stroke-width="2"/>')
    svg.append(f'<path d="M{x+38} 1128 H{x+62} M{x+38} 1143 H{x+62} M{x+38} 1158 H{x+62}" stroke="{acc}" stroke-width="4" stroke-linecap="round"/>')
    svg.append(text(x+96,1128,title,27,TEXT,800))
    svg.append(text(x+96,1164,desc,19,MUTED,450,family='var(--font-mono)'))
    svg.append('</g>')

# trust band
svg.append(rounded_rect(120,1288,2560,250,fill='#071326',stroke='#27476d',sw=2,r=28,opacity=0.88))
svg.append(text(W/2,1335,'BUILT FOR TRUST, RECOVERY AND HUMAN CONTROL',32,BLUE,850,family='var(--font-display)',anchor='middle',extra='class="micro"'))
for i,(title,desc) in enumerate(trust_cols):
    x=165+i*505
    if i>0:
        svg.append(f'<line x1="{x-32}" y1="1368" x2="{x-32}" y2="1496" stroke="#375778" stroke-opacity="0.65"/>')
    svg.append(f'<circle cx="{x+28}" cy="1423" r="35" fill="#06162b" stroke="{[CYAN,BLUE,GREEN,MAGENTA,ORANGE][i]}" stroke-width="2.4"/>')
    # simple glyphs: check, lock, eye etc.
    glyph=['⌂','◆','✓','↔','◎'][i]
    svg.append(text(x+28,1436,glyph,34,[CYAN,BLUE,GREEN,MAGENTA,ORANGE][i],800,anchor='middle',family='var(--font-mono)'))
    svg.append(text(x+82,1412,title,29,TEXT,800))
    svg.append(text(x+82,1451,desc,21,MUTED,450))

# footer callout
svg.append(f'<line x1="120" y1="1576" x2="2680" y2="1576" stroke="{CYAN}" stroke-opacity="0.5"/>')
svg.append(text(120,1613,'codex-issue-runner // Web · CLI · Feishu · Sessions · PI Guardian · Verification',21,CYAN,800,family='var(--font-mono)',extra='class="micro"'))
svg.append(text(2680,1613,'self-hosted engineering agent runtime',21,MUTED,600,family='var(--font-mono)',anchor='end'))

svg.append('</svg>')
OUT.write_text('\n'.join(svg), encoding='utf-8')
print(OUT)
