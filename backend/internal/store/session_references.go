package store

import "context"

type SessionTurnReferenceRecord struct {
	ID                int64  `json:"id"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	ProviderTurnID    string `json:"provider_turn_id"`
	ReferencesJSON    string `json:"references_json"`
	CreatedAt         string `json:"created_at"`
}

func (s *Store) SaveSessionTurnReferences(ctx context.Context, rec SessionTurnReferenceRecord) error {
	if rec.Provider == "" {
		rec.Provider = ProviderCodex
	}
	_, err := s.db.ExecContext(ctx, `insert into session_turn_references
		(provider, provider_session_id, provider_turn_id, references_json, created_at)
		values (?, ?, ?, ?, ?)`,
		rec.Provider, rec.ProviderSessionID, rec.ProviderTurnID, rec.ReferencesJSON, now())
	return err
}

func (s *Store) ListSessionTurnReferences(ctx context.Context, sessionID, turnID string) ([]SessionTurnReferenceRecord, error) {
	rows, err := s.db.QueryContext(ctx, `select id, provider, provider_session_id,
		provider_turn_id, references_json, created_at from session_turn_references
		where provider_session_id=? and provider_turn_id=? order by id asc`, sessionID, turnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []SessionTurnReferenceRecord{}
	for rows.Next() {
		var rec SessionTurnReferenceRecord
		if err := rows.Scan(&rec.ID, &rec.Provider, &rec.ProviderSessionID,
			&rec.ProviderTurnID, &rec.ReferencesJSON, &rec.CreatedAt); err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	return records, rows.Err()
}
