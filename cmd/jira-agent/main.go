package main

import (
	"context"
	"os"

	"github.com/zackbunch/jira-dc-mock-server/internal/command"
)

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	command.Version = version
	command.Commit = commit
	command.Date = date
	os.Exit(command.Run(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
