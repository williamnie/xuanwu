package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type InstalledCapability struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Summary string `json:"summary"`
	Path    string `json:"path,omitempty"`
}

type InstalledCapabilities struct {
	Skills  []InstalledCapability `json:"skills"`
	Plugins []InstalledCapability `json:"plugins"`
}

func DiscoverInstalledCapabilities() InstalledCapabilities {
	home, err := os.UserHomeDir()
	if err != nil {
		return InstalledCapabilities{}
	}
	root := filepath.Join(home, ".codex")
	return InstalledCapabilities{
		Skills:  discoverInstalledSkills(root),
		Plugins: discoverInstalledPlugins(root),
	}
}

func findInstalledSkill(name string) (InstalledCapability, bool) {
	return findCapabilityByName(DiscoverInstalledCapabilities().Skills, name)
}

func findInstalledPlugin(name string) (InstalledCapability, bool) {
	return findCapabilityByName(DiscoverInstalledCapabilities().Plugins, name)
}

func discoverInstalledSkills(root string) []InstalledCapability {
	seen := map[string]InstalledCapability{}
	for _, base := range skillDiscoveryDirs(root) {
		addSkillDir(seen, base)
	}
	addPluginSkills(seen, filepath.Join(root, "plugins", "cache"))
	return sortedCapabilities(seen)
}

func discoverInstalledPlugins(root string) []InstalledCapability {
	seen := map[string]InstalledCapability{}
	cache := filepath.Join(root, "plugins", "cache")
	_ = filepath.WalkDir(cache, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != "plugin.json" || filepath.Base(filepath.Dir(path)) != ".codex-plugin" {
			return nil
		}
		item := parsePluginManifest(path)
		if item.Name != "" && seen[item.Name].Name == "" {
			seen[item.Name] = item
		}
		return nil
	})
	return sortedCapabilities(seen)
}

func skillDiscoveryDirs(root string) []string {
	return []string{
		filepath.Join(root, "skills"),
		filepath.Join(root, "skills", ".system"),
		filepath.Join(root, "superpowers", "skills"),
	}
}

func addSkillDir(seen map[string]InstalledCapability, base string) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(base, entry.Name(), "SKILL.md")
		if !entry.IsDir() || !isReadableFile(path) {
			continue
		}
		addCapability(seen, parseSkillManifest(path, entry.Name()))
	}
}

func addPluginSkills(seen map[string]InstalledCapability, cache string) {
	_ = filepath.WalkDir(cache, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != "SKILL.md" || filepath.Base(filepath.Dir(filepath.Dir(path))) != "skills" {
			return nil
		}
		addCapability(seen, parseSkillManifest(path, filepath.Base(filepath.Dir(path))))
		return nil
	})
}

func addCapability(seen map[string]InstalledCapability, item InstalledCapability) {
	if item.Name == "" || seen[item.Name].Name != "" {
		return
	}
	seen[item.Name] = item
}

func parseSkillManifest(path, fallbackName string) InstalledCapability {
	name, desc := parseSkillHeader(path)
	name = firstNonEmpty(name, fallbackName)
	return InstalledCapability{Name: name, Type: "skill", Summary: desc, Path: path}
}

func parsePluginManifest(path string) InstalledCapability {
	var raw struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Interface   struct {
			ShortDescription string `json:"shortDescription"`
			LongDescription  string `json:"longDescription"`
		} `json:"interface"`
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &raw) != nil {
		return InstalledCapability{}
	}
	summary := firstNonEmpty(raw.Description, raw.Interface.ShortDescription, raw.Interface.LongDescription)
	return InstalledCapability{Name: cleanCapabilityName(raw.Name), Type: "plugin", Summary: cleanCapabilitySummary(summary), Path: filepath.Dir(filepath.Dir(path))}
}

func parseSkillHeader(path string) (string, string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	return yamlHeaderValue(string(data), "name"), yamlHeaderValue(string(data), "description")
}

func yamlHeaderValue(text, key string) string {
	prefix := key + ":"
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return cleanCapabilitySummary(strings.TrimSpace(strings.TrimPrefix(line, prefix)))
		}
	}
	return ""
}

func sortedCapabilities(seen map[string]InstalledCapability) []InstalledCapability {
	items := make([]InstalledCapability, 0, len(seen))
	for _, item := range seen {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items
}

func findCapabilityByName(items []InstalledCapability, name string) (InstalledCapability, bool) {
	want := cleanCapabilityName(name)
	for _, item := range items {
		if strings.EqualFold(item.Name, want) {
			return item, true
		}
	}
	return InstalledCapability{}, false
}

func cleanCapabilityName(value string) string {
	return strings.TrimSpace(value)
}

func cleanCapabilitySummary(value string) string {
	return strings.Trim(strings.Join(strings.Fields(value), " "), `"'`)
}

func isReadableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
