// Package anthropic — minimal HTTP client for the Anthropic Messages API.
//
// Notflix uses it for ONE thing only: subtitle translation. Rather than
// pull in the official SDK (which carries streaming, vision, tools and
// a sizable dep graph) we hand-write a 100-line client that does
// exactly what we need — one method, one model, one prompt shape.
package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	endpoint = "https://api.anthropic.com/v1/messages"
	apiVer   = "2023-06-01"
)

type Client struct {
	http *http.Client

	mu     sync.RWMutex
	apiKey string
	model  string
}

func NewClient(apiKey, model string) *Client {
	if model == "" {
		model = "claude-haiku-4-5"
	}
	return &Client{
		apiKey: apiKey,
		model:  model,
		// Translation is one-shot, no streaming; 60 s is comfortable.
		http: &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) HasKey() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey != ""
}

func (c *Client) SetCredentials(apiKey, model string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.apiKey = apiKey
	if model != "" {
		c.model = model
	}
}

func (c *Client) snapshot() (apiKey, model string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey, c.model
}

// Message — a single turn in the conversation. We only send `user`
// messages; the system prompt rides on the top-level "system" field.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// MessagesRequest mirrors the Anthropic /v1/messages schema. Only the
// fields we actually set are modelled — anything else is left to the
// server's defaults.
type MessagesRequest struct {
	Model       string    `json:"model"`
	MaxTokens   int       `json:"max_tokens"`
	System      string    `json:"system,omitempty"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type messagesResponse struct {
	ID         string         `json:"id"`
	Model      string         `json:"model"`
	StopReason string         `json:"stop_reason"`
	Content    []contentBlock `json:"content"`
	Usage      struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

// SendMessage is the only public method. Returns the concatenated text
// of every content block in the response. Errors out on non-2xx HTTP
// status, surface-level API errors (auth, rate limit, …), or a
// malformed response body.
func (c *Client) SendMessage(ctx context.Context, req MessagesRequest) (string, error) {
	apiKey, model := c.snapshot()
	if apiKey == "" {
		return "", fmt.Errorf("anthropic: API key not configured")
	}
	if req.Model == "" {
		req.Model = model
	}
	if req.MaxTokens == 0 {
		req.MaxTokens = 4096
	}

	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", apiVer)
	httpReq.Header.Set("content-type", "application/json")

	res, err := c.http.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	if res.StatusCode >= 400 {
		return "", fmt.Errorf("anthropic %d: %s", res.StatusCode, string(raw))
	}
	var parsed messagesResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("anthropic: decode: %w (body: %s)", err, string(raw))
	}
	var out bytes.Buffer
	for _, b := range parsed.Content {
		if b.Type == "text" {
			out.WriteString(b.Text)
		}
	}
	return out.String(), nil
}
