# Guardian 事件队列的读取与保留

`pi_guardian_event_inbox` 是后台事件队列，同时保留生命周期通知的审计锚点；它与前端
「待我处理」的聚合列表不同。Provider 终止错误仍可进入此队列。Supervisor 主路径则直接
决策和执行动作，不能仅凭某段时间队列没有流量就移除剩余恢复入口。

## 热路径

- 迁移 `094_guardian_inbox_active_index` 只增加索引，不删除或改写事件。
- `idx_pi_guardian_event_active(status, sequence_id, project_id, created_at)` 只包含
  `pending` 和 `leased`。健康检查与消费者显式选择该索引，避免 SQLite 在低基数状态统计下
  为省去分组排序而扫描包含历史的项目索引。
- 索引谓词使用 `status='pending' OR status='leased'`，消费者只写 `status='pending'`，按
  [SQLite 的部分索引匹配规则](https://www.sqlite.org/partialindex.html#queries_using_partial_indexes)
  直接匹配单一状态范围，避免冗余 IN 条件在部分版本、统计条件下引入额外排序。
- 消费者只处理 `pending`，在 SQL 中按 `sequence_id` 升序限制批量；不再先取全部 payload
  再在 JavaScript 中截断。`leased` 仅保留原有健康检查兼容语义，不新增租约生产逻辑。
- 默认每批 50 条，轮内批次之间让出事件循环，每轮最多处理 250 条。事件不会因预算耗尽被
  标成已消费；下一轮继续。返回的 `guardianDecisions.truncated` 为 1 表示达到上限且仍有
  pending，为 0 表示没有因本轮上限留下 pending；慢阶段日志会保留这个数值标记。
- 合并证据中保留的最近 20 个事件 ID 会去重，在该证据窗口内重放同一事件不会再次增加
  `event_count`。动作仍走原有租约、幂等和授权流程。

默认健康检查仍在每轮结束后等待 30 秒，事件超过 5 分钟未处理时告警。该调整没有改变
失败事件的重试或告警策略，也没有合并 Supervisor 与 Guardian 的两条恢复路径。
单条 SQLite 调用和单个事件的处理仍是同步的，批次上限并非严格的墙钟时限。

## 验证

部署后可用只读连接检查以下计划；预期使用 `idx_pi_guardian_event_active`，不能回到
`idx_pi_guardian_event_issue`。消费者不应出现 `TEMP B-TREE FOR ORDER BY`。

```sql
EXPLAIN QUERY PLAN
SELECT project_id, count(*) AS count, min(created_at)
FROM pi_guardian_event_inbox INDEXED BY idx_pi_guardian_event_active
WHERE (status='pending' OR status='leased') AND created_at <= '2026-01-01T00:00:00Z'
GROUP BY project_id ORDER BY count DESC, project_id ASC LIMIT 50;

EXPLAIN QUERY PLAN
SELECT sequence_id, id, normalized_payload_json
FROM pi_guardian_event_inbox INDEXED BY idx_pi_guardian_event_active
WHERE status='pending'
ORDER BY sequence_id ASC LIMIT 50;
```

自动化回归覆盖混合状态、截止时间边界、历史统计、迁移幂等、FIFO、积压跨轮继续、批间让出
以及重放幂等。代码验证不能替代线上 I/O 高压场景的运行验收。

## 历史保留边界

历史数据不再影响上述热路径，本次不增加自动删除或在启动迁移中清理数据。后续维护应独立
预览、归档、检查引用并分批操作，不能把 `consumed` 直接等同于可删除：

- 决策的 `source_event_id`、`source_event_sequence_id` 及合并证据中的 `event_ids` 会引用事件。
- 生命周期事件参与通知意图的来源和幂等；通知偏好的序列游标还依赖历史顺序。
- Provider 终止信号以已存在的事件行去重，删除后可能被补漏逻辑重新产生。
- 偏好游标当前读取事件表的最大 `sequence_id`；清理不能让该水位回退。
- 已停用的 `supervisor:` / `supervisor-budget:` 来源可作为后续维护的审查范围，但仍须检查
  决策、通知和 heartbeat 记录的引用，保留仍被引用的数据，不能直接按前缀删除。
