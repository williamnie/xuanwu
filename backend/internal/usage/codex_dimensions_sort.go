package usage

import "sort"

type usageRankItem struct {
	Usage TokenUsage
	ID    string
}

func sortedProjects(values map[string]*UsageProjectAggregate) []UsageProjectAggregate {
	items := make([]UsageProjectAggregate, 0, len(values))
	for _, value := range values {
		items = append(items, *value)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Unknown != items[j].Unknown {
			return !items[i].Unknown
		}
		return usageRank(
			usageRankItem{Usage: items[i].Usage, ID: items[i].ID},
			usageRankItem{Usage: items[j].Usage, ID: items[j].ID},
		)
	})
	return items
}

func sortedSessions(values []UsageSessionAggregate) []UsageSessionAggregate {
	sort.SliceStable(values, func(i, j int) bool {
		if values[i].Unknown != values[j].Unknown {
			return !values[i].Unknown
		}
		return usageRank(
			usageRankItem{Usage: values[i].Usage, ID: values[i].ID},
			usageRankItem{Usage: values[j].Usage, ID: values[j].ID},
		)
	})
	return values
}

func sortedIssues(values []UsageIssueAggregate) []UsageIssueAggregate {
	sort.SliceStable(values, func(i, j int) bool {
		if values[i].Usage.TotalTokens != values[j].Usage.TotalTokens {
			return values[i].Usage.TotalTokens > values[j].Usage.TotalTokens
		}
		return values[i].ID < values[j].ID
	})
	return values
}

func upsertIssue(values []UsageIssueAggregate, next UsageIssueAggregate) []UsageIssueAggregate {
	for i := range values {
		if values[i].ID == next.ID {
			values[i] = next
			return values
		}
	}
	return append(values, next)
}

func usageRank(left usageRankItem, right usageRankItem) bool {
	if left.Usage.TotalTokens != right.Usage.TotalTokens {
		return left.Usage.TotalTokens > right.Usage.TotalTokens
	}
	return left.ID < right.ID
}
