package workspace

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const gitCommandTimeout = 5 * time.Second
const maxGitStderrBytes = 8 * 1024

type cappedBuffer struct{ data []byte }

func (b *cappedBuffer) Write(value []byte) (int, error) {
	written := len(value)
	remaining := maxGitStderrBytes - len(b.data)
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		b.data = append(b.data, value...)
	}
	return written, nil
}

func (b *cappedBuffer) String() string { return string(b.data) }

type repositoryState struct {
	root      string
	workspace string
	branch    *string
	head      string
}

func gitArgs(args ...string) []string {
	return append([]string{
		"-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false",
		"-c", "diff.external=",
		"--no-pager",
	}, args...)
}

func runGit(root string, maxBytes int64, args ...string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitCommandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", append([]string{"-C", root}, gitArgs(args...)...)...)
	command.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "LANG=C")
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	var stderr cappedBuffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, false, ErrNotRepository
		}
		return nil, false, err
	}
	data, readErr := io.ReadAll(io.LimitReader(stdout, maxBytes+1))
	truncated := int64(len(data)) > maxBytes
	if truncated {
		data = data[:maxBytes]
		_ = command.Process.Kill()
	}
	waitErr := command.Wait()
	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	if readErr != nil {
		return nil, false, readErr
	}
	if truncated {
		return data, true, nil
	}
	if waitErr != nil {
		return nil, false, &gitError{err: waitErr, stderr: strings.TrimSpace(stderr.String())}
	}
	return data, false, nil
}

type gitError struct {
	err    error
	stderr string
}

func (e *gitError) Error() string {
	if e.stderr == "" {
		return e.err.Error()
	}
	return e.stderr
}

func (e *gitError) Unwrap() error { return e.err }

func optionalGitLine(root string, args ...string) *string {
	data, _, err := runGit(root, 4096, args...)
	if err != nil {
		return nil
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return nil
	}
	return &value
}

func (i *Inspector) repository(workspaceRoot string) (repositoryState, error) {
	workspaceRoot, err := canonicalRoot(workspaceRoot)
	if err != nil {
		return repositoryState{}, err
	}
	data, _, err := runGit(workspaceRoot, 8192, "rev-parse", "--show-toplevel")
	if err != nil {
		return repositoryState{}, ErrNotRepository
	}
	repoRoot, err := canonicalRoot(strings.TrimSpace(string(data)))
	if err != nil || !within(repoRoot, workspaceRoot) {
		return repositoryState{}, ErrNotRepository
	}
	head := optionalGitLine(workspaceRoot, "rev-parse", "--verify", "HEAD")
	branch := optionalGitLine(workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD")
	state := repositoryState{root: repoRoot, workspace: workspaceRoot, branch: branch}
	if head != nil {
		state.head = *head
	}
	return state, nil
}

func aheadBehind(root string) (int, int) {
	data, _, err := runGit(root, 128, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
	if err != nil {
		return 0, 0
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 {
		return 0, 0
	}
	behind, behindErr := strconv.Atoi(fields[0])
	ahead, aheadErr := strconv.Atoi(fields[1])
	if behindErr != nil || aheadErr != nil {
		return 0, 0
	}
	return ahead, behind
}
