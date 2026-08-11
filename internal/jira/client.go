package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultUserAgent = "jira-agent/dev"

// Client is a small Jira Data Center REST client.
type Client struct {
	BaseURL   *url.URL
	Token     string
	Username  string
	Password  string
	UserAgent string
	HTTP      *http.Client
}

// Response contains the parts of an HTTP response useful to a CLI caller.
type Response struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// HTTPError represents a non-2xx Jira response.
type HTTPError struct {
	StatusCode int
	Body       []byte
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("Jira returned HTTP %d", e.StatusCode)
}

// NewClient validates configuration and creates a client.
func NewClient(baseURL, token, username, password string, timeout time.Duration) (*Client, error) {
	if timeout <= 0 {
		return nil, errors.New("timeout must be greater than zero")
	}

	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse base URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("base URL must use http or https")
	}
	if parsed.Host == "" {
		return nil, errors.New("base URL must include a host")
	}

	return &Client{
		BaseURL:   parsed,
		Token:     token,
		Username:  username,
		Password:  password,
		UserAgent: defaultUserAgent,
		HTTP:      &http.Client{Timeout: timeout},
	}, nil
}

// Do sends a request. Path may be relative to BaseURL or an absolute URL on the
// same host. Query values are encoded by net/url.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body []byte, headers http.Header) (*Response, error) {
	target, err := c.resolve(path)
	if err != nil {
		return nil, err
	}
	if len(query) > 0 {
		values := target.Query()
		for key, items := range query {
			for _, item := range items {
				values.Add(key, item)
			}
		}
		target.RawQuery = values.Encode()
	}

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	} else if c.Username != "" {
		req.SetBasicAuth(c.Username, c.Password)
	}

	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("send request: %w", err)
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	result := &Response{StatusCode: response.StatusCode, Header: response.Header.Clone(), Body: responseBody}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, &HTTPError{StatusCode: response.StatusCode, Body: responseBody}
	}
	return result, nil
}

func (c *Client) resolve(path string) (*url.URL, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("request path cannot be empty")
	}

	target, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse request path: %w", err)
	}
	if target.IsAbs() {
		if !sameOrigin(c.BaseURL, target) {
			return nil, errors.New("absolute request URL must have the same origin as the base URL")
		}
		return target, nil
	}

	base := *c.BaseURL
	base.Path = strings.TrimRight(base.Path, "/") + "/"
	return base.ResolveReference(&url.URL{Path: strings.TrimLeft(target.Path, "/"), RawQuery: target.RawQuery}), nil
}

func sameOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

// JSONBody marshals a request payload without HTML escaping.
func JSONBody(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buffer.Bytes()), nil
}
