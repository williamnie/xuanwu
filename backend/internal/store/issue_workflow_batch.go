package store

import "context"

type workflowSnapshotRow struct {
	id       int64
	snapshot string
}

func (s *Store) updateWorkflowSnapshotsForStatus(
	ctx context.Context,
	fromStatus string,
	toStatus string,
	evidence string,
	actor string,
) error {
	rows, err := s.db.QueryContext(ctx, `select id, workflow_snapshot_json from issues where status=?`, fromStatus)
	if err != nil {
		return err
	}
	items, err := scanWorkflowSnapshotRows(rows)
	if err != nil {
		return err
	}
	return s.updateWorkflowSnapshotRows(ctx, items, toStatus, evidence, actor)
}

func (s *Store) updateWorkflowSnapshotRows(
	ctx context.Context,
	items []workflowSnapshotRow,
	toStatus string,
	evidence string,
	actor string,
) error {
	t := now()
	for _, item := range items {
		next := nextWorkflowSnapshot(item.snapshot, toStatus, evidence, actor, "", t)
		if _, err := s.db.ExecContext(ctx, `update issues set workflow_snapshot_json=? where id=?`, next, item.id); err != nil {
			return err
		}
	}
	return nil
}
