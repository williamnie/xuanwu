package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const maxImageUploadBytes = 10 << 20

func (s *Server) routeUploads(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "images" && requireMethod(w, r, http.MethodPost) {
		s.createImageUpload(w, r)
		return
	}
	if len(parts) == 3 && parts[2] == "content" && requireMethod(w, r, http.MethodGet) {
		s.writeUploadContent(w, r, parts[1])
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) createImageUpload(w http.ResponseWriter, r *http.Request) {
	file, header, err := readMultipartImage(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	upload, err := s.persistImageUpload(r, file, header.Filename)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, upload)
}

func readMultipartImage(w http.ResponseWriter, r *http.Request) ([]byte, *multipart.FileHeader, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxImageUploadBytes+1024)
	if err := r.ParseMultipartForm(maxImageUploadBytes); err != nil {
		return nil, nil, fmt.Errorf("图片上传请求不合法")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, nil, fmt.Errorf("缺少 file 字段")
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maxImageUploadBytes+1))
	if err != nil || int64(len(body)) > maxImageUploadBytes {
		return nil, nil, fmt.Errorf("图片不能超过 10MB")
	}
	return body, header, nil
}

func (s *Server) persistImageUpload(r *http.Request, data []byte, filename string) (store.Upload, error) {
	mimeType, ext, err := detectImage(data, filename)
	if err != nil {
		return store.Upload{}, err
	}
	id, err := randomUploadID()
	if err != nil {
		return store.Upload{}, err
	}
	path := uploadPath(s.store.UploadRoot(), id, ext)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return store.Upload{}, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return store.Upload{}, err
	}
	return s.store.CreateUpload(r.Context(), uploadRecord(id, filename, mimeType, data, path))
}

func (s *Server) writeUploadContent(w http.ResponseWriter, r *http.Request, id string) {
	upload, err := s.store.GetUpload(r.Context(), id)
	if err != nil {
		handleErr(w, err)
		return
	}
	w.Header().Set("Content-Type", upload.MimeType)
	http.ServeFile(w, r, upload.StoragePath)
}

func detectImage(data []byte, filename string) (string, string, error) {
	mimeType := http.DetectContentType(data)
	ext := strings.ToLower(filepath.Ext(filename))
	if mimeType == "application/octet-stream" && ext == ".webp" {
		mimeType = "image/webp"
	}
	if !allowedImageMime(mimeType) {
		return "", "", fmt.Errorf("仅支持 png/jpg/webp/gif 图片")
	}
	return mimeType, imageExt(mimeType), nil
}

func allowedImageMime(mimeType string) bool {
	switch mimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func imageExt(mimeType string) string {
	switch mimeType {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	default:
		return ".webp"
	}
}

func uploadPath(root, id, ext string) string {
	now := time.Now().UTC()
	return filepath.Join(root, now.Format("2006"), now.Format("01"), id+ext)
}

func uploadRecord(id, name, mimeType string, data []byte, path string) store.Upload {
	sum := sha256.Sum256(data)
	return store.Upload{
		ID: id, OriginalName: safeOriginalName(name), MimeType: mimeType,
		SizeBytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), StoragePath: path,
	}
}

func safeOriginalName(name string) string {
	cleaned := filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if cleaned == "." || cleaned == "/" || cleaned == "" {
		return "image"
	}
	return cleaned
}

func randomUploadID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "upload_" + hex.EncodeToString(buf[:]), nil
}
