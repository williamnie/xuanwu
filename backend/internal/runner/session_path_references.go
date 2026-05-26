package runner

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxFileReferenceBytes = 64 * 1024
	maxFolderTreeEntries  = 50
)

func pathReferenceSummary(root, target, rel, typ string, info os.FileInfo) string {
	if typ == "folder" {
		return folderReferenceSummary(target, rel)
	}
	return fileReferenceSummary(target, rel, info.Size())
}

func fileReferenceSummary(target, rel string, size int64) string {
	content, truncated, binary := readFileReferenceContent(target)
	head := fmt.Sprintf("file %s · %s", filepath.ToSlash(rel), formatReferenceBytes(size))
	if binary {
		return head + "\n  content: <binary omitted>"
	}
	if truncated {
		head += fmt.Sprintf(" · truncated to %s", formatReferenceBytes(maxFileReferenceBytes))
	}
	return head + "\n  content:\n" + indentReferenceBlock(content)
}

func folderReferenceSummary(target, rel string) string {
	entries, total := folderTreeEntries(target)
	lines := []string{fmt.Sprintf("folder %s · files: %d", filepath.ToSlash(rel), total)}
	if len(entries) > 0 {
		lines = append(lines, "tree:")
		for _, entry := range entries {
			lines = append(lines, "- "+entry)
		}
	}
	return strings.Join(lines, "\n  ")
}

func readFileReferenceContent(target string) (string, bool, bool) {
	data, err := os.ReadFile(target)
	if err != nil {
		return "<read error: " + err.Error() + ">", false, false
	}
	truncated := len(data) > maxFileReferenceBytes
	if truncated {
		data = data[:maxFileReferenceBytes]
	}
	if looksBinary(data) {
		return "", truncated, true
	}
	return strings.TrimRight(string(data), "\n"), truncated, false
}

func folderTreeEntries(root string) ([]string, int) {
	entries := []string{}
	total := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == root || d.IsDir() {
			return nil
		}
		total++
		if len(entries) >= maxFolderTreeEntries {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr == nil {
			entries = append(entries, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(entries)
	return entries, total
}

func looksBinary(data []byte) bool {
	for _, b := range data {
		if b == 0 {
			return true
		}
	}
	return false
}

func indentReferenceBlock(text string) string {
	if text == "" {
		return "  <empty>"
	}
	return "  " + strings.ReplaceAll(text, "\n", "\n  ")
}

func formatReferenceBytes(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	if bytes < 1024*1024 {
		return fmt.Sprintf("%d KB", bytes/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(bytes)/1024/1024)
}
