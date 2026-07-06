---
name: fixture-domain
description: Use when fixture attention inbox items should become action proposals.
---

# Fixture Domain Skill

Reads a neutral attention inbox item and proposes bounded next actions.

It is source-neutral and proposal-only:
- `bug_report` -> `issue.create`
- `status_question` -> `issue.status_lookup` + `message.reply_draft`
- `reply_needed` -> `message.reply_draft`
- `monitor_thread` / `watch_thread` suggestion -> `watch_thread`
- `reminder.create` / `memory.create` suggestion -> matching proposal for later review
- ambiguous `other` -> `ask_user`
- `no_action` suggestion -> `no_action`

The fixture must not execute external writes directly.
