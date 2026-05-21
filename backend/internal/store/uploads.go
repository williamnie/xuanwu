package store

import (
	"context"
	"database/sql"
	"errors"
)

const uploadSelect = `select id, original_name, mime_type, size_bytes, sha256,
	storage_path, created_at from uploads`

func (s *Store) CreateUpload(ctx context.Context, upload Upload) (Upload, error) {
	if upload.ID == "" {
		return Upload{}, errors.New("upload id 不能为空")
	}
	if upload.OriginalName == "" {
		upload.OriginalName = upload.ID
	}
	createdAt := now()
	_, err := s.db.ExecContext(ctx, `insert into uploads
		(id, original_name, mime_type, size_bytes, sha256, storage_path, created_at)
		values (?, ?, ?, ?, ?, ?, ?)`,
		upload.ID, upload.OriginalName, upload.MimeType, upload.SizeBytes,
		upload.SHA256, upload.StoragePath, createdAt)
	if err != nil {
		return Upload{}, err
	}
	return s.GetUpload(ctx, upload.ID)
}

func (s *Store) GetUpload(ctx context.Context, id string) (Upload, error) {
	row := s.db.QueryRowContext(ctx, uploadSelect+` where id = ?`, id)
	upload, err := scanUpload(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Upload{}, ErrNotFound
	}
	return upload, err
}

func uploadContentURL(id string) string {
	return "/api/uploads/" + id + "/content"
}
