.PHONY: cli cli-test cli-release test

VERSION ?= dev

cli:
	@mkdir -p bin
	go build -trimpath -ldflags "-X main.version=$(VERSION)" -o bin/jira-agent ./cmd/jira-agent

cli-test:
	go test ./...

test: cli-test
	npm test

cli-release:
	go run ./scripts/build-cli.go --version "$(VERSION)"
