# Shared Issue Planning Contract

Canonical planning rules for external Xuanwu agents and built-in Supervisor chat. Each entry point uses its supported tools and permission gates; these rules do not authorize extra work or change lifecycle authority.

## Plain-Language Contract

User-facing titles, goals, plans, and summaries must **说人话**: describe concrete, observable results in short sentences. Follow the host's explicit output-language contract; otherwise match the language of the user's current request. For Chinese output, write Issue titles, `一句话目标`, headings, and summaries in Simplified Chinese. Preserve identifiers, commands, and proper nouns. This document's instruction language does not set the output language.

Every Issue must have one `一句话目标`. Prefer a verb and a concrete result, such as “用户撤销设备后，旧设备不能再连接”; avoid jargon such as “能力闭环” or “状态治理”. Keep technical details only when they help execution or tracking, and cite authoritative material instead of repeating it.

## Plan and Decompose Work

Read the relevant PRD/design/roadmap or conversation before proposing Issues. Cover goals, non-goals, acceptance criteria, open questions, and required ordering.

- Split by independently useful, verifiable outcomes. Each Issue needs one main result, bounded scope, non-goals, acceptance, replayable validation, and necessary dependencies. Generic frontend/backend/tests buckets are not sufficient boundaries.
- Do not target a fixed Issue count. Determine the count dynamically from outcomes, implementation boundaries, risk, environments, and ordering. Recheck Issues that join separate results with “以及/并且”, could merge independently, or would rerun unrelated work after a partial failure. Do not force equal sizes.
- Separate the shortest MVP chain from later productization, polish, migration, rollout, and manual acceptance. For a large DAG, create/enqueue the current phase and summarize later phases; create the full backlog when requested.
- Routine self-checks, normal review, and completion cards are part of implementation. Separate verification only for a distinct environment, owner, device, account, or evidence outcome.
- Ask at most one question for the entire batch, only when needed to start safely. Put other unresolved decisions in human triage Issues; hold any implementation that genuinely requires those decisions first.
- If review is requested before creation, present the numbered plan and dependencies without mutations. Creation does not imply permission to start a batch.

## Unattended Eligibility Gate

Classify Issues as `夜间可执行` (repository and existing non-interactive access suffice) or `需要人工` (device interaction, QR/OTP/CAPTCHA, fresh login/authorization, user choice, subjective visual judgment, payment, external communication, release approval, or an unavailable person/system).

- Only enqueue `夜间可执行` Issues in an unattended batch. Create `需要人工` Issues as `triage` and do not enqueue them, even when the user says “全部开始”. State the human requirement.
- Confirm the selected Agent Profile resolves to `approval=unattended`, has sufficient already-authorized access, and will not trigger interactive tool approvals. Check credentials without exposing secrets, required services/emulators, upstream state, and known network/rate-limit availability. Hold affected Issues in triage when prerequisites are unavailable.
- Split implementation plus automated checks from manual acceptance. Preserve every real acceptance requirement and name the manual Issue in implementation non-goals; the manual Issue references the implementation and reviews its Run evidence. Required manual work must finish before claiming overall acceptance.
- Do not make unrelated implementation wait on manual acceptance. Genuine decision/release gates stay out of the night queue until their manual prerequisites are done.
- If a human need appears at runtime, report `needs_user` truthfully through the executor/Host/PI outcome path. Never label it `failed` or `done` merely to release the workspace lock or trigger retries.
- Before starting, report unattended count, human-held Issues and reasons, and remaining risks of entering needs_user. Failed/cancelled success prerequisites block downstream work; report them for daytime handling and do not invent unauthorized compensation work.

## Compact Issue Body

Normally stay under about 800 Chinese characters excluding commands/links when the executor can reread a stable repository path or durable source. If essential context exists only in the planning conversation, include enough for a fresh executor even when longer. Do not replace necessary facts with inaccessible references.

Use these sections, translated for the active output language. Preserve their order; optional evidence and open questions follow them. Every Issue needs goal, scope, acceptance, and dependencies. Include non-goals when deferring scope and name related Issues after real IDs exist. Choose automated validation for unattended work or manual acceptance for human work; include device/account/environment, actions, required evidence, and implementation Run review in manual acceptance.

```markdown
## 一句话目标
<完成后可观察到的变化>
## 做什么
- <必要范围>
## 不做什么
- <交给其他阶段或人工 Issue 的范围；无排除项时省略>
## 验收标准
- <可判断的结果>
## 自动验证
- `<可复跑命令>`
## 依赖
- 无，或 Issue #<id>
```

For manual work replace `自动验证` with `人工验收`. English headings: Goal, Scope, Non-goals, Acceptance criteria, Automated validation / Manual acceptance, Dependencies. The goal explains the outcome; acceptance explains how to prove it. Do not fill optional sections with empty boilerplate.

## Dependency Contract

Always keep `依赖`/Dependencies: `无`/None or exact `Issue #<id>` references matching structured dependency IDs. Non-goals and evidence references are provenance, not hard dependencies.

Create batches in triage. Each entry point may temporarily use an empty dependency section until real IDs exist; resolve references and the entire structured graph, read back every Issue, and finish preflight before enqueueing. Keep an incomplete batch in triage and report the unfinished graph. Only edit planning metadata on triage/todo Issues that never created a Run.

Use same-Project success prerequisites only, without self-reference or cycles. Every prerequisite must be done before downstream execution. Cleanup, rollback verification, incident review, or reports that must run after failure must not hard-depend on upstream success; retain upstream IDs as provenance and act after observing authoritative terminal state.

## Compact Creation Summary

Lead with confirmed results. Do not make the user read every Issue body. If manual acceptance remains, say `待人工验收 N 项，完成前不算整体验收通过。` before a compact table:

| Issue | 一句话目标 | 类型 | 依赖 | 今晚运行 |
| --- | --- | --- | --- | --- |
| #<id> | <具体结果> | 自动 / 人工（原因） | 无 / #<id> | 是 / 否 |

Report total/unattended counts, unexpected human holds and reasons, longest dependency chain, downstream work blocked by failed/cancelled prerequisites, and remaining night-run risks. Explain split boundaries in at most one sentence. For large plans show the current phase and group later phases without hiding goals or manual requirements; omit repeated PRD, CLI narration, and unrequested architecture commentary.
