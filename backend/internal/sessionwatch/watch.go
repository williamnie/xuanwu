package sessionwatch

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

const (
	EventSessionCreated = "session.created"
	EventSessionUpdated = "session.updated"
)

var threadIDPattern = regexp.MustCompile(`([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$`)

type Watcher struct {
	root    string
	bus     *events.Bus
	watcher *fsnotify.Watcher
	known   map[string]struct{}
	mu      sync.Mutex
}

func New(root string, bus *events.Bus) *Watcher {
	return &Watcher{root: root, bus: bus, known: map[string]struct{}{}}
}

func (w *Watcher) Start(ctx context.Context) error {
	if strings.TrimSpace(w.root) == "" {
		return nil
	}
	if _, err := os.Stat(w.root); err != nil {
		log.Printf("codex session watcher skipped: %s", err)
		return nil
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.watcher = watcher
	if err := w.addTree(w.root, false); err != nil {
		_ = watcher.Close()
		return err
	}
	go w.run(ctx)
	return nil
}

func (w *Watcher) run(ctx context.Context) {
	defer w.watcher.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case err, ok := <-w.watcher.Errors:
			if ok {
				log.Printf("codex session watcher error: %v", err)
			}
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handle(event)
		}
	}
}

func (w *Watcher) handle(event fsnotify.Event) {
	if event.Has(fsnotify.Create) && isDir(event.Name) {
		if err := w.addTree(event.Name, true); err != nil {
			log.Printf("codex session watcher add %s: %v", event.Name, err)
		}
		return
	}
	if !isSessionWrite(event) {
		return
	}
	w.publishFile(event.Name)
}

func (w *Watcher) addTree(root string, publishExisting bool) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return w.watcher.Add(path)
		}
		if publishExisting && isSessionFile(path) {
			w.publishFile(path)
		}
		if !publishExisting && isSessionFile(path) {
			w.markKnown(path)
		}
		return nil
	})
}

func (w *Watcher) publishFile(path string) {
	threadID := threadIDFromPath(path)
	if threadID == "" {
		return
	}
	eventType := EventSessionUpdated
	if w.markKnown(path) {
		eventType = EventSessionCreated
	}
	w.bus.Publish(events.AppEvent{Type: eventType, ThreadID: threadID, Payload: path})
}

func (w *Watcher) markKnown(path string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.known[path]; ok {
		return false
	}
	w.known[path] = struct{}{}
	return true
}

func isSessionWrite(event fsnotify.Event) bool {
	if !isSessionFile(event.Name) {
		return false
	}
	return event.Has(fsnotify.Create) || event.Has(fsnotify.Write) || event.Has(fsnotify.Rename)
}

func isSessionFile(path string) bool {
	return strings.HasSuffix(path, ".jsonl") && threadIDFromPath(path) != ""
}

func threadIDFromPath(path string) string {
	match := threadIDPattern.FindStringSubmatch(filepath.Base(path))
	if len(match) != 2 {
		return ""
	}
	return match[1]
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
