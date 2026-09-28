# 玄武技能库

技能库供玄武自己的对话和执行任务使用。入口是「设置 → 高级 → 技能」，也可以直接告诉玄武要安装、使用、更新或卸载哪个技能。内置 Pi SDK 当前锁定为 **0.87.1**。

## 对话使用

```text
看看这个仓库有哪些技能：https://github.com/owner/repository
把其中的 my-skill 安装到当前项目，启用并验证加载。
使用 my-skill 处理下面这份材料：……
把 my-skill 更新到最新版本，保留可回滚版本。
停用当前项目的 my-skill。
```

玄武通过 `capability_search` 发现管理工具，通过 `skill_use` 读取技能正文及引用资料；刚安装的技能可以在同一轮使用。后续对话会重新发现启用的技能，无需重启服务。

| 工具 | 用途 |
| --- | --- |
| `skill_inspect_source` | 识别来源中的技能名称和子目录，不安装或执行脚本 |
| `skill_library_list` | 查询来源、作用域、当前版本、启用状态与实际授权状态 |
| `skill_install` | 校验、安装，默认启用；可只安装而不启用 |
| `skill_manage` | 启用、停用、更新、回滚、卸载；必须提供当前版本 |
| `skill_verify` | 校验完整性、Pi 加载、工具依赖和已注册 handler |
| `skill_use` | 读取当前允许使用的技能正文或指定的引用文件 |

技能只提供工作说明，不增加权限。需要脚本、依赖安装、构建或代码修改时，由玄武交给现有 Coding Provider 执行，携带具体任务、技能版本和 `base_directory`。安装目录不可变，输出、依赖和缓存放在任务工作区；不要直接改写已安装的技能包。

## 安装来源

- **Git**：支持 GitHub、GitLab、Bitbucket 的 HTTPS 仓库，以及 GitHub 的 `tree/<ref>/<子目录>` 链接。可单独填写分支、标签或 commit SHA 及技能子目录。分支名含 `/` 时，优先分别填写仓库地址、ref 和子目录。私有或其他托管来源可先检出到本地，再使用本地目录安装。
- **本地目录**：复制包含 `SKILL.md` 的目录，保留 `references/`、`scripts/`、`assets/` 等资源。
- **直接编写**：提供带 YAML front matter 的 `SKILL.md`，支持多行描述。技能名称必须与 `name` 一致，为不超过 64 位的小写字母、数字和连字符。

```markdown
---
name: release-review
description: 汇总本次发布的变更、验证结果和剩余事项。
---
读取当前任务的证据，分别说明代码验证、发布结果和未验证项目。
```

页面中的「识别技能」可以列出一个仓库内的候选项，选择后自动填入名称和子目录。不会覆盖尚未选择的用户输入。

## 作用域与发现

- **项目级**：仅当前项目可用，同名技能优先于实例级版本。项目级显式启用是该项目的技能授权，仍受当前运行时和委派允许列表限制。
- **实例级**：供各项目共享；项目现有允许列表仍可限制使用。列表会标明被项目版本覆盖或被策略限制的状态。
- 同名项目技能被停用时，不会退回实例版本继续执行。
- 保留仓库内置、PI 资源包、项目 `.pi/skills`、运行时资源目录、Codex skills 等已有发现入口。注册表和对话加载共用解析结果；「发现」与「启用」分别展示。
- `disable-model-invocation: true` 的技能不进入自动推荐提示，但仍可显式调用允许使用的技能。

托管包及目录索引保存在 `<数据库所在目录>/skill-library/`。项目级安装按项目 ID 隔离，也使用这套目录，不向项目 Git 工作区写入安装产物。原始本地目录、Codex 全局目录和来源仓库不会被覆盖。

## 更新、回滚与验证

每个安装版本保存来源、Git commit、文件摘要和安装时间。更新先取得新版本并校验，成功后原子切换索引；失败时保留原版本。相同来源、commit 和内容的更新不制造新版本。回滚使用本地保留版本，不需要网络。卸载会撤销索引并删除玄武管理的版本文件，保留已有审计记录，不删除原始来源。

校验结果分为 `ready`、`disabled` 和 `blocked`。文件被修改、资源缺失、工具依赖缺失或 handler 未注册时，技能不会加载使用。`skill_verify` 不执行真实任务，也不会把加载通过报告为任务执行成功；真实执行应以对话工具记录、Coding Provider 的 Run 或已有 Intake/Domain 运行记录为准。

安装包限制为 512 个文件/目录、16 MiB、12 层目录；单次正文和资源读取不超过 128 KiB。拒绝符号链接、目录逃逸、特殊文件和凭据文件，不运行 Git hooks、安装脚本或包管理器生命周期脚本。并发操作使用独占锁，崩溃后可识别已退出进程的锁；更新操作还检查调用方提供的版本，防止覆盖别人的新版本。

## HTTP 接口

使用现有玄武 API 身份认证：

```text
GET  /api/pi/skill-library?project_id=<可选项目>
GET  /api/pi/skill-library/:key
POST /api/pi/skill-library/inspect
POST /api/pi/skill-library/install
POST /api/pi/skill-library/manage
POST /api/pi/skill-library/verify
```

安装请求示例：

```json
{
  "id": "my-skill",
  "scope": "project",
  "project_id": "my-project",
  "source": {
    "kind": "git",
    "location": "https://github.com/owner/repository",
    "ref": "main",
    "subdirectory": "skills/my-skill"
  },
  "enabled": true
}
```

管理请求使用列表返回的 `key` 和 `revision`：

```json
{ "key": "<key>", "expected_revision": "<revision>", "operation": "rollback" }
```

管理动作经过现有 Action Gate 和 PI Action 审计；对话中的实际调用另有工具审计。权限拒绝、版本冲突和缺失依赖都会显式返回，不会自动扩大工具或委派权限。
