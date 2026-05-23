package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const generatedTokenBytes = 32

func ResolveAuthToken(cfg Config) (string, error) {
	if token := strings.TrimSpace(cfg.AuthToken); token != "" {
		return token, nil
	}
	token, generated, err := tokenFromFile(cfg.AuthTokenFile)
	if generated && err == nil {
		printTokenNotice(cfg.AuthTokenFile)
	}
	return token, err
}

func defaultAuthTokenFile(dbPath string) string {
	dir := filepath.Dir(dbPath)
	if dir == "." || dir == "" {
		dir = "data"
	}
	return filepath.Join(dir, "auth_token")
}

func tokenFromFile(path string) (string, bool, error) {
	if token, err := readToken(path); err == nil && token != "" {
		return token, false, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}
	token, err := generateToken()
	if err != nil {
		return "", false, err
	}
	return token, true, writeTokenFile(path, token)
}

func readToken(path string) (string, error) {
	body, err := os.ReadFile(path)
	return strings.TrimSpace(string(body)), err
}

func writeTokenFile(path string, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(token+"\n"), 0o600)
}

func printTokenNotice(path string) {
	_, _ = os.Stderr.WriteString("Codex Issue Runner generated auth token file: " + path + "\n")
}

func generateToken() (string, error) {
	buf := make([]byte, generatedTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
