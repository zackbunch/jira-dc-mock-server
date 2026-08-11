package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/zackbunch/jira-dc-mock-server/internal/jira"
)

var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

const helpText = `jira-agent is an agent-friendly Jira Data Center CLI.

Usage:
  jira-agent [global flags] <command> [arguments]

Global flags (must precede the command):
  --base-url URL       Jira URL (JIRA_BASE_URL; default http://localhost:8080)
  --token TOKEN        bearer token (JIRA_TOKEN or JIRA_MOCK_TOKEN)
  --username NAME      Basic Auth username (JIRA_USERNAME)
  --password PASSWORD  Basic Auth password (JIRA_PASSWORD)
  --timeout DURATION   request timeout (default 30s)
  --compact            emit compact JSON
  --raw                emit response bodies without JSON formatting

Commands:
  health
  server-info
  myself
  project list
  project get KEY
  issue search --jql JQL [--fields CSV] [--start-at N] [--max-results N]
  issue get KEY [--fields CSV] [--expand CSV]
  issue create --project KEY --type TYPE --summary TEXT [options]
  issue edit KEY --data JSON|@FILE|@-
  issue delete KEY
  comment list KEY [--start-at N] [--max-results N]
  comment add KEY --body TEXT
  transition list KEY
  transition perform KEY ID
  request METHOD PATH [--query KEY=VALUE] [--header KEY=VALUE] [--data JSON|@FILE|@-]
  reset --confirm
  version

All successful commands write JSON to stdout. Errors write JSON to stderr.
Run "jira-agent --help" to show this reference.
`

type config struct {
	baseURL  string
	token    string
	username string
	password string
	timeout  time.Duration
	compact  bool
	raw      bool
}

type runner struct {
	client *jira.Client
	cfg    config
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

type usageError struct{ message string }

func (e *usageError) Error() string { return e.message }

type valuesFlag []string

func (v *valuesFlag) String() string { return strings.Join(*v, ",") }
func (v *valuesFlag) Set(value string) error {
	*v = append(*v, value)
	return nil
}

// Run executes the CLI and returns a process exit code.
func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	cfg, remaining, help, err := parseGlobals(args)
	if help {
		fmt.Fprint(stdout, helpText)
		return 0
	}
	if err != nil {
		writeError(stderr, "usage", err.Error(), 0, nil)
		return 2
	}
	if len(remaining) == 0 {
		fmt.Fprint(stdout, helpText)
		return 0
	}

	client, err := jira.NewClient(cfg.baseURL, cfg.token, cfg.username, cfg.password, cfg.timeout)
	if err != nil {
		writeError(stderr, "configuration", err.Error(), 0, nil)
		return 2
	}
	client.UserAgent = "jira-agent/" + Version
	r := &runner{client: client, cfg: cfg, stdin: stdin, stdout: stdout, stderr: stderr}

	err = r.dispatch(ctx, remaining)
	if err == nil {
		return 0
	}
	var usage *usageError
	if errors.As(err, &usage) {
		writeError(stderr, "usage", usage.Error(), 0, nil)
		return 2
	}
	var httpErr *jira.HTTPError
	if errors.As(err, &httpErr) {
		writeError(stderr, "http", httpErr.Error(), httpErr.StatusCode, httpErr.Body)
		return 3
	}
	writeError(stderr, "request", err.Error(), 0, nil)
	return 1
}

func parseGlobals(args []string) (config, []string, bool, error) {
	cfg := config{
		baseURL:  envOr("JIRA_BASE_URL", "http://localhost:8080"),
		token:    firstEnv("JIRA_TOKEN", "JIRA_MOCK_TOKEN"),
		username: firstEnv("JIRA_USERNAME", "JIRA_MOCK_USERNAME"),
		password: firstEnv("JIRA_PASSWORD", "JIRA_MOCK_PASSWORD"),
		timeout:  30 * time.Second,
	}
	flags := flag.NewFlagSet("jira-agent", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.baseURL, "base-url", cfg.baseURL, "")
	flags.StringVar(&cfg.token, "token", cfg.token, "")
	flags.StringVar(&cfg.username, "username", cfg.username, "")
	flags.StringVar(&cfg.password, "password", cfg.password, "")
	flags.DurationVar(&cfg.timeout, "timeout", cfg.timeout, "")
	flags.BoolVar(&cfg.compact, "compact", false, "")
	flags.BoolVar(&cfg.raw, "raw", false, "")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return cfg, nil, true, nil
		}
		return cfg, nil, false, err
	}
	if cfg.token == "" && cfg.username == "" && isLocalURL(cfg.baseURL) {
		cfg.token = "local-test-token"
	}
	return cfg, flags.Args(), false, nil
}

func (r *runner) dispatch(ctx context.Context, args []string) error {
	switch args[0] {
	case "help", "--help", "-h":
		fmt.Fprint(r.stdout, helpText)
		return nil
	case "version":
		return r.writeValue(map[string]string{"version": Version, "commit": Commit, "date": Date})
	case "health":
		return r.call(ctx, http.MethodGet, "/health", nil, nil, nil)
	case "server-info":
		return r.call(ctx, http.MethodGet, "/rest/api/2/serverInfo", nil, nil, nil)
	case "myself":
		return r.call(ctx, http.MethodGet, "/rest/api/2/myself", nil, nil, nil)
	case "project":
		return r.project(ctx, args[1:])
	case "issue":
		return r.issue(ctx, args[1:])
	case "comment":
		return r.comment(ctx, args[1:])
	case "transition":
		return r.transition(ctx, args[1:])
	case "request":
		return r.request(ctx, args[1:])
	case "reset":
		return r.reset(ctx, args[1:])
	default:
		return use("unknown command %q", args[0])
	}
}

func (r *runner) project(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return use("project requires a subcommand: list or get")
	}
	switch args[0] {
	case "list":
		flags := newFlags("project list")
		expand := flags.String("expand", "", "")
		if err := parseFlags(flags, args[1:]); err != nil {
			return err
		}
		query := url.Values{}
		addIfSet(query, "expand", *expand)
		return r.call(ctx, http.MethodGet, "/rest/api/2/project", query, nil, nil)
	case "get":
		if len(args) < 2 {
			return use("usage: jira-agent project get KEY [--expand CSV]")
		}
		flags := newFlags("project get")
		expand := flags.String("expand", "", "")
		if err := parseFlags(flags, args[2:]); err != nil {
			return err
		}
		query := url.Values{}
		addIfSet(query, "expand", *expand)
		return r.call(ctx, http.MethodGet, "/rest/api/2/project/"+url.PathEscape(args[1]), query, nil, nil)
	default:
		return use("unknown project subcommand %q", args[0])
	}
}

func (r *runner) issue(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return use("issue requires a subcommand: search, get, create, edit, or delete")
	}
	switch args[0] {
	case "search":
		flags := newFlags("issue search")
		jql := flags.String("jql", "", "")
		fields := flags.String("fields", "", "")
		expand := flags.String("expand", "", "")
		startAt := flags.Int("start-at", 0, "")
		maxResults := flags.Int("max-results", 50, "")
		if err := parseFlags(flags, args[1:]); err != nil {
			return err
		}
		if strings.TrimSpace(*jql) == "" {
			return use("issue search requires --jql")
		}
		if *startAt < 0 || *maxResults < 0 {
			return use("--start-at and --max-results must be non-negative")
		}
		payload := map[string]any{"jql": *jql, "startAt": *startAt, "maxResults": *maxResults}
		if *fields != "" {
			payload["fields"] = splitCSV(*fields)
		}
		if *expand != "" {
			payload["expand"] = splitCSV(*expand)
		}
		return r.callJSON(ctx, http.MethodPost, "/rest/api/2/search", nil, payload)
	case "get":
		if len(args) < 2 {
			return use("usage: jira-agent issue get KEY [--fields CSV] [--expand CSV]")
		}
		flags := newFlags("issue get")
		fields := flags.String("fields", "", "")
		expand := flags.String("expand", "", "")
		if err := parseFlags(flags, args[2:]); err != nil {
			return err
		}
		query := url.Values{}
		addIfSet(query, "fields", *fields)
		addIfSet(query, "expand", *expand)
		return r.call(ctx, http.MethodGet, issuePath(args[1]), query, nil, nil)
	case "create":
		return r.createIssue(ctx, args[1:])
	case "edit":
		if len(args) < 2 {
			return use("usage: jira-agent issue edit KEY --data JSON|@FILE|@-")
		}
		flags := newFlags("issue edit")
		data := flags.String("data", "", "")
		if err := parseFlags(flags, args[2:]); err != nil {
			return err
		}
		body, err := r.payload(*data, true)
		if err != nil {
			return err
		}
		return r.call(ctx, http.MethodPut, issuePath(args[1]), nil, body, nil)
	case "delete":
		if len(args) != 2 {
			return use("usage: jira-agent issue delete KEY")
		}
		return r.call(ctx, http.MethodDelete, issuePath(args[1]), nil, nil, nil)
	default:
		return use("unknown issue subcommand %q", args[0])
	}
}

func (r *runner) createIssue(ctx context.Context, args []string) error {
	flags := newFlags("issue create")
	project := flags.String("project", "", "")
	issueType := flags.String("type", "", "")
	summary := flags.String("summary", "", "")
	description := flags.String("description", "", "")
	assignee := flags.String("assignee", "", "")
	priority := flags.String("priority", "", "")
	labels := flags.String("labels", "", "")
	fieldsJSON := flags.String("fields-json", "", "")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if *project == "" || *issueType == "" || *summary == "" {
		return use("issue create requires --project, --type, and --summary")
	}

	fields := map[string]any{}
	if *fieldsJSON != "" {
		if err := json.Unmarshal([]byte(*fieldsJSON), &fields); err != nil {
			return use("invalid --fields-json: %v", err)
		}
	}
	fields["project"] = map[string]string{"key": *project}
	fields["issuetype"] = map[string]string{"name": *issueType}
	fields["summary"] = *summary
	if *description != "" {
		fields["description"] = *description
	}
	if *assignee != "" {
		fields["assignee"] = map[string]string{"name": *assignee}
	}
	if *priority != "" {
		fields["priority"] = map[string]string{"name": *priority}
	}
	if *labels != "" {
		fields["labels"] = splitCSV(*labels)
	}
	return r.callJSON(ctx, http.MethodPost, "/rest/api/2/issue", nil, map[string]any{"fields": fields})
}

func (r *runner) comment(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return use("usage: jira-agent comment <list|add> KEY [flags]")
	}
	path := issuePath(args[1]) + "/comment"
	switch args[0] {
	case "list":
		flags := newFlags("comment list")
		startAt := flags.Int("start-at", 0, "")
		maxResults := flags.Int("max-results", 50, "")
		if err := parseFlags(flags, args[2:]); err != nil {
			return err
		}
		if *startAt < 0 || *maxResults < 0 {
			return use("--start-at and --max-results must be non-negative")
		}
		query := url.Values{"startAt": {strconv.Itoa(*startAt)}, "maxResults": {strconv.Itoa(*maxResults)}}
		return r.call(ctx, http.MethodGet, path, query, nil, nil)
	case "add":
		flags := newFlags("comment add")
		body := flags.String("body", "", "")
		if err := parseFlags(flags, args[2:]); err != nil {
			return err
		}
		if *body == "" {
			return use("comment add requires --body")
		}
		return r.callJSON(ctx, http.MethodPost, path, nil, map[string]string{"body": *body})
	default:
		return use("unknown comment subcommand %q", args[0])
	}
}

func (r *runner) transition(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return use("usage: jira-agent transition <list|perform> KEY [ID]")
	}
	path := issuePath(args[1]) + "/transitions"
	switch args[0] {
	case "list":
		if len(args) != 2 {
			return use("usage: jira-agent transition list KEY")
		}
		return r.call(ctx, http.MethodGet, path, nil, nil, nil)
	case "perform":
		if len(args) != 3 {
			return use("usage: jira-agent transition perform KEY ID")
		}
		return r.callJSON(ctx, http.MethodPost, path, nil, map[string]any{"transition": map[string]string{"id": args[2]}})
	default:
		return use("unknown transition subcommand %q", args[0])
	}
}

func (r *runner) request(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return use("usage: jira-agent request METHOD PATH [--query KEY=VALUE] [--header KEY=VALUE] [--data JSON|@FILE|@-]")
	}
	flags := newFlags("request")
	var queryFlags valuesFlag
	var headerFlags valuesFlag
	flags.Var(&queryFlags, "query", "")
	flags.Var(&headerFlags, "header", "")
	data := flags.String("data", "", "")
	if err := parseFlags(flags, args[2:]); err != nil {
		return err
	}
	query, err := keyValues(queryFlags)
	if err != nil {
		return use("invalid --query: %v", err)
	}
	headers, err := headerValues(headerFlags)
	if err != nil {
		return use("invalid --header: %v", err)
	}
	var body []byte
	if *data != "" {
		body, err = r.payload(*data, false)
		if err != nil {
			return err
		}
	}
	return r.call(ctx, strings.ToUpper(args[0]), args[1], query, body, headers)
}

func (r *runner) reset(ctx context.Context, args []string) error {
	flags := newFlags("reset")
	confirm := flags.Bool("confirm", false, "")
	if err := parseFlags(flags, args); err != nil {
		return err
	}
	if !*confirm {
		return use("reset is destructive; pass --confirm")
	}
	return r.call(ctx, http.MethodPost, "/__admin/reset", nil, nil, nil)
}

func (r *runner) callJSON(ctx context.Context, method, path string, query url.Values, payload any) error {
	body, err := jira.JSONBody(payload)
	if err != nil {
		return fmt.Errorf("encode request: %w", err)
	}
	return r.call(ctx, method, path, query, body, nil)
}

func (r *runner) call(ctx context.Context, method, path string, query url.Values, body []byte, headers http.Header) error {
	response, err := r.client.Do(ctx, method, path, query, body, headers)
	if err != nil {
		return err
	}
	return r.writeResponse(response)
}

func (r *runner) writeResponse(response *jira.Response) error {
	if len(bytes.TrimSpace(response.Body)) == 0 {
		return r.writeValue(map[string]int{"status": response.StatusCode})
	}
	if r.cfg.raw {
		_, err := r.stdout.Write(response.Body)
		if err == nil && len(response.Body) > 0 && response.Body[len(response.Body)-1] != '\n' {
			_, err = fmt.Fprintln(r.stdout)
		}
		return err
	}
	var value any
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return fmt.Errorf("response is not valid JSON (use --raw to print it): %w", err)
	}
	return r.writeValue(value)
}

func (r *runner) writeValue(value any) error {
	encoder := json.NewEncoder(r.stdout)
	encoder.SetEscapeHTML(false)
	if !r.cfg.compact {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(value)
}

func (r *runner) payload(value string, requireJSON bool) ([]byte, error) {
	var body []byte
	var err error
	switch {
	case value == "":
		return nil, use("--data is required")
	case value == "@-":
		body, err = io.ReadAll(r.stdin)
	case strings.HasPrefix(value, "@"):
		body, err = os.ReadFile(strings.TrimPrefix(value, "@"))
	default:
		body = []byte(value)
	}
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if requireJSON && !json.Valid(body) {
		return nil, use("request body must be valid JSON")
	}
	return body, nil
}

func newFlags(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func parseFlags(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return use("help requested for %s; see jira-agent --help", flags.Name())
		}
		return use("%v", err)
	}
	if flags.NArg() != 0 {
		return use("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	return nil
}

func keyValues(items []string) (url.Values, error) {
	result := url.Values{}
	for _, item := range items {
		key, value, found := strings.Cut(item, "=")
		if !found || key == "" {
			return nil, fmt.Errorf("expected KEY=VALUE, got %q", item)
		}
		result.Add(key, value)
	}
	return result, nil
}

func headerValues(items []string) (http.Header, error) {
	result := http.Header{}
	for _, item := range items {
		key, value, found := strings.Cut(item, "=")
		if !found || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("expected KEY=VALUE, got %q", item)
		}
		result.Add(strings.TrimSpace(key), value)
	}
	return result, nil
}

func addIfSet(values url.Values, key, value string) {
	if value != "" {
		values.Set(key, value)
	}
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func issuePath(key string) string {
	return "/rest/api/2/issue/" + url.PathEscape(key)
}

func use(format string, args ...any) error {
	return &usageError{message: fmt.Sprintf(format, args...)}
}

func isLocalURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return ""
}

func writeError(output io.Writer, kind, message string, status int, body []byte) {
	value := map[string]any{"error": kind, "message": message}
	if status != 0 {
		value["status"] = status
	}
	if len(bytes.TrimSpace(body)) > 0 {
		var response any
		if json.Unmarshal(body, &response) == nil {
			value["response"] = response
		} else {
			value["response"] = string(body)
		}
	}
	// encoding/json sorts string map keys, keeping agent parsing and snapshots stable.
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}
