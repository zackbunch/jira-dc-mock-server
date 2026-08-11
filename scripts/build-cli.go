//go:build ignore

// Build jira-agent release archives without requiring GoReleaser.
// Run from the repository root: go run ./scripts/build-cli.go
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type target struct {
	os   string
	arch string
}

var targets = []target{
	{os: "darwin", arch: "amd64"},
	{os: "darwin", arch: "arm64"},
	{os: "linux", arch: "amd64"},
	{os: "linux", arch: "arm64"},
	{os: "windows", arch: "amd64"},
	{os: "windows", arch: "arm64"},
}

func main() {
	output := flag.String("output", "dist/cli", "artifact directory")
	version := flag.String("version", detectVersion(), "version embedded in binaries")
	flag.Parse()

	commit := commandOutput("git", "rev-parse", "--short=12", "HEAD")
	if commit == "" {
		commit = "none"
	}
	date := time.Now().UTC().Format(time.RFC3339)
	if sourceDate := os.Getenv("SOURCE_DATE_EPOCH"); sourceDate != "" {
		if seconds, err := strconv.ParseInt(sourceDate, 10, 64); err == nil {
			date = time.Unix(seconds, 0).UTC().Format(time.RFC3339)
		}
	}

	if err := os.RemoveAll(*output); err != nil {
		fatal(err)
	}
	if err := os.MkdirAll(*output, 0o755); err != nil {
		fatal(err)
	}
	stage, err := os.MkdirTemp("", "jira-agent-build-")
	if err != nil {
		fatal(err)
	}
	defer os.RemoveAll(stage)

	checksums := map[string]string{}
	for _, item := range targets {
		name := fmt.Sprintf("jira-agent_%s_%s_%s", strings.TrimPrefix(*version, "v"), item.os, item.arch)
		binaryName := "jira-agent"
		if item.os == "windows" {
			binaryName += ".exe"
		}
		binaryPath := filepath.Join(stage, name, binaryName)
		if err := os.MkdirAll(filepath.Dir(binaryPath), 0o755); err != nil {
			fatal(err)
		}

		ldflags := fmt.Sprintf("-s -w -X main.version=%s -X main.commit=%s -X main.date=%s", *version, commit, date)
		command := exec.Command("go", "build", "-trimpath", "-ldflags", ldflags, "-o", binaryPath, "./cmd/jira-agent")
		command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+item.os, "GOARCH="+item.arch)
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
		fmt.Printf("building %s/%s\n", item.os, item.arch)
		if err := command.Run(); err != nil {
			fatal(err)
		}

		archiveName := name + ".tar.gz"
		if item.os == "windows" {
			archiveName = name + ".zip"
		}
		archivePath := filepath.Join(*output, archiveName)
		if item.os == "windows" {
			err = writeZip(archivePath, binaryPath, binaryName)
		} else {
			err = writeTarGzip(archivePath, binaryPath, binaryName)
		}
		if err != nil {
			fatal(err)
		}
		checksums[archiveName], err = checksum(archivePath)
		if err != nil {
			fatal(err)
		}
	}

	names := make([]string, 0, len(checksums))
	for name := range checksums {
		names = append(names, name)
	}
	sort.Strings(names)
	var lines strings.Builder
	for _, name := range names {
		fmt.Fprintf(&lines, "%s  %s\n", checksums[name], name)
	}
	if err := os.WriteFile(filepath.Join(*output, "SHA256SUMS"), []byte(lines.String()), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %d archives and SHA256SUMS to %s\n", len(targets), *output)
}

func writeTarGzip(destination, source, name string) error {
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	defer output.Close()
	gzipWriter := gzip.NewWriter(output)
	tarWriter := tar.NewWriter(gzipWriter)
	contents, err := os.ReadFile(source)
	if err == nil {
		err = tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(contents)), ModTime: time.Unix(0, 0)})
	}
	if err == nil {
		_, err = tarWriter.Write(contents)
	}
	if closeErr := tarWriter.Close(); err == nil {
		err = closeErr
	}
	if closeErr := gzipWriter.Close(); err == nil {
		err = closeErr
	}
	return err
}

func writeZip(destination, source, name string) error {
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	defer output.Close()
	zipWriter := zip.NewWriter(output)
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(0o755)
	// ZIP timestamps cannot represent dates before 1980.
	header.SetModTime(time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC))
	entry, err := zipWriter.CreateHeader(header)
	if err == nil {
		var input *os.File
		input, err = os.Open(source)
		if err == nil {
			_, err = io.Copy(entry, input)
			_ = input.Close()
		}
	}
	if closeErr := zipWriter.Close(); err == nil {
		err = closeErr
	}
	return err
}

func checksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func detectVersion() string {
	if value := os.Getenv("VERSION"); value != "" {
		return value
	}
	if value := commandOutput("git", "describe", "--tags", "--always", "--dirty"); value != "" {
		return value
	}
	return "dev"
}

func commandOutput(name string, args ...string) string {
	output, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "build failed: %v\n", err)
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "ensure go.exe is available on PATH")
	}
	os.Exit(1)
}
