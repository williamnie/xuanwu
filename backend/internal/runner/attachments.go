package runner

import (
	"context"
	"regexp"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

var attachmentImagePattern = regexp.MustCompile(`!\[[^\]]*\]\(attachment://([A-Za-z0-9._-]+)\)`)

func buildTurnInput(ctx context.Context, st *store.Store, markdown string) ([]agent.UserInput, error) {
	prompt := strings.TrimSpace(markdown)
	if prompt == "" {
		return nil, nil
	}
	matches := attachmentImagePattern.FindAllStringSubmatchIndex(prompt, -1)
	if len(matches) == 0 {
		return []agent.UserInput{agent.TextInput(prompt)}, nil
	}
	return buildAttachmentInput(ctx, st, prompt, matches)
}

func buildAttachmentInput(
	ctx context.Context,
	st *store.Store,
	prompt string,
	matches [][]int,
) ([]agent.UserInput, error) {
	inputs := []agent.UserInput{}
	cursor := 0
	for _, match := range matches {
		appendTextInput(&inputs, prompt[cursor:match[0]])
		uploadID := prompt[match[2]:match[3]]
		upload, err := st.GetUpload(ctx, uploadID)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, agent.LocalImageInput(upload.StoragePath))
		cursor = match[1]
	}
	appendTextInput(&inputs, prompt[cursor:])
	return inputs, nil
}

func appendTextInput(inputs *[]agent.UserInput, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	*inputs = append(*inputs, agent.TextInput(text))
}
