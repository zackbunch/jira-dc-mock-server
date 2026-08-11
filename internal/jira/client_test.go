package jira

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestClientDo(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/jira/rest/api/2/search" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Get("jql") != "project = TEST" {
			t.Errorf("query = %q", request.URL.RawQuery)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("authorization = %q", got)
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != `{"maxResults":1}` {
			t.Errorf("body = %q", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"total":1}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL+"/jira", "secret", "", "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(
		context.Background(),
		http.MethodPost,
		"/rest/api/2/search",
		url.Values{"jql": {"project = TEST"}},
		[]byte(`{"maxResults":1}`),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(response.Body) != `{"total":1}` {
		t.Fatalf("response = %#v", response)
	}
}

func TestClientReturnsHTTPError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"errorMessages":["missing"]}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "", "developer", "developer", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(context.Background(), http.MethodGet, "/missing", nil, nil, nil)
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("error = %v", err)
	}
	if httpErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", httpErr.StatusCode)
	}
}

func TestClientRejectsCrossOriginAbsoluteURL(t *testing.T) {
	t.Parallel()

	client, err := NewClient("https://jira.example.test", "secret", "", "", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(context.Background(), http.MethodGet, "https://other.example.test/rest/api/2/myself", nil, nil, nil)
	if err == nil {
		t.Fatal("expected cross-origin URL error")
	}
}
