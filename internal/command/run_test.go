package command

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIssueSearch(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/rest/api/2/search" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["jql"] != "project = TEST" || body["maxResults"] != float64(5) {
			t.Fatalf("body = %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"issues":[],"total":0}`))
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"--base-url", server.URL,
		"--token", "test-token",
		"--compact",
		"issue", "search",
		"--jql", "project = TEST",
		"--max-results", "5",
	}, bytes.NewReader(nil), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if stdout.String() != "{\"issues\":[],\"total\":0}\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestHTTPErrorIsJSONOnStderr(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"errorMessages":["missing"]}`))
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"--base-url", server.URL, "health"}, bytes.NewReader(nil), &stdout, &stderr)
	if code != 3 {
		t.Fatalf("code = %d", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q", stdout.String())
	}
	var value map[string]any
	if err := json.Unmarshal(stderr.Bytes(), &value); err != nil {
		t.Fatalf("stderr is not JSON: %v", err)
	}
	if value["status"] != float64(http.StatusNotFound) || value["error"] != "http" {
		t.Fatalf("stderr = %#v", value)
	}
}

func TestEditReadsBodyFromStdin(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if request.Method != http.MethodPut || string(body) != `{"fields":{"summary":"Updated"}}` {
			t.Fatalf("request = %s, body = %s", request.Method, body)
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"--base-url", server.URL,
		"issue", "edit", "TEST-1", "--data", "@-",
	}, bytes.NewBufferString(`{"fields":{"summary":"Updated"}}`), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d, stderr = %s", code, stderr.String())
	}
	if stdout.String() != "{\n  \"status\": 204\n}\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestLocalMockGetsDefaultTokenOnly(t *testing.T) {
	t.Parallel()

	local, _, _, err := parseGlobals([]string{"--base-url", "http://127.0.0.1:8080", "--token=", "--username=", "health"})
	if err != nil {
		t.Fatal(err)
	}
	if local.token != "local-test-token" {
		t.Fatalf("local token = %q", local.token)
	}

	external, _, _, err := parseGlobals([]string{"--base-url", "https://jira.example.test", "--token=", "--username=", "health"})
	if err != nil {
		t.Fatal(err)
	}
	if external.token != "" {
		t.Fatalf("external token = %q", external.token)
	}
}

func TestResetRequiresConfirmation(t *testing.T) {
	t.Parallel()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"reset"}, bytes.NewReader(nil), &stdout, &stderr)
	if code != 2 {
		t.Fatalf("code = %d", code)
	}
	if !json.Valid(stderr.Bytes()) {
		t.Fatalf("stderr is not JSON: %s", stderr.String())
	}
}
