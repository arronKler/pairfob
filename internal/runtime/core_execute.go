package runtime

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func (c *Core) Execute(ctx context.Context, session SessionRef, operationID string, command Command) (Receipt, error) {
	if operationID == "" || len(operationID) > 128 || !utf8.ValidString(operationID) {
		return notApplied(operationID, invalidFault("execute", "valid operation id is required"))
	}
	c.opMu.Lock()
	defer c.opMu.Unlock()
	if err := coreDefaultSession("execute", session); err != nil {
		return notApplied(operationID, err)
	}
	// Reject a command this adapter cannot express before asking for a
	// connection, so an unsupported command never depends on the core being up.
	switch command.(type) {
	case SendTextCommand, SendKeysCommand, RenamePaneCommand, ClosePaneCommand, CreateConversationCommand, PromptAgentCommand:
	default:
		return notApplied(operationID, coreUnsupportedCommand(command))
	}
	conn, hello, err := c.connection(ctx)
	if err != nil {
		return notApplied(operationID, err)
	}
	switch value := command.(type) {
	case SendTextCommand:
		return c.coreSendText(ctx, conn, hello, operationID, value)
	case SendKeysCommand:
		return c.coreSendKeys(ctx, conn, hello, operationID, value)
	case RenamePaneCommand:
		return c.coreRenamePane(ctx, conn, hello, operationID, value)
	case ClosePaneCommand:
		return c.coreClosePane(ctx, conn, hello, operationID, value)
	case CreateConversationCommand:
		return c.coreCreateConversation(ctx, conn, hello, operationID, value)
	case PromptAgentCommand:
		return c.corePromptAgent(ctx, conn, hello, operationID, value)
	default:
		return notApplied(operationID, coreUnsupportedCommand(command))
	}
}

// coreRawKeys maps keys whose terminal bytes never depend on the program's
// keyboard modes. terminal.keys encodes for those modes and holds keys back
// until pasted text has been quiet, so these common keys go straight to the
// attach stream and keep their order with the text before them. Arrows are
// absent on purpose: their bytes change with the application-cursor mode.
// Ctrl+C stays a literal byte, never terminal.interrupt: the phone's stop flow
// sends Esc first and then exactly one Ctrl+C, and a second stop key would
// change that two-step meaning.
func coreRawKeys(keys []string) ([]byte, bool) {
	if len(keys) == 0 {
		return nil, false
	}
	out := make([]byte, 0, len(keys))
	for _, key := range keys {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "enter", "return":
			out = append(out, '\r')
		case "esc", "escape":
			out = append(out, '\x1b')
		case "ctrl+c", "ctrl-c":
			out = append(out, '\x03')
		case "tab":
			out = append(out, '\t')
		case "backspace", "bs":
			out = append(out, '\x7f')
		default:
			return nil, false
		}
	}
	return out, true
}

func coreRequireMethod(hello coreHello, operation string, methods ...string) error {
	for _, method := range methods {
		if !hello.has(method) {
			return unsupported(operation, "operation is unsupported by the terminal core")
		}
	}
	return nil
}

func coreFailure(operationID string, err error) (Receipt, error) {
	return receiptForError(operationID, err), err
}

func (c *Core) coreSendText(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command SendTextCommand) (Receipt, error) {
	const operation = "pane.send_text"
	if command.PaneID == "" {
		return notApplied(operationID, invalidFault(operation, "pane id is required"))
	}
	terminal, err := decodeCorePaneID(command.PaneID)
	if err != nil {
		return notApplied(operationID, err)
	}
	if command.Text == "" {
		return Receipt{OperationID: operationID, Outcome: OutcomeNoop}, nil
	}
	if err := coreRequireMethod(hello, operation, "terminal.get", "terminal.attach"); err != nil {
		return notApplied(operationID, err)
	}
	channel, err := c.coreInput(ctx, conn, terminal, operation)
	if err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, false))
	}
	if err := conn.TypeInput(channel, []byte(command.Text)); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityPane, ID: command.PaneID}}}, nil
}

func (c *Core) coreSendKeys(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command SendKeysCommand) (Receipt, error) {
	const operation = "pane.send_keys"
	if command.PaneID == "" || len(command.Keys) == 0 {
		return notApplied(operationID, invalidFault(operation, "pane id and keys are required"))
	}
	terminal, err := decodeCorePaneID(command.PaneID)
	if err != nil {
		return notApplied(operationID, err)
	}
	// The core holds terminal.keys back until typed text goes quiet (2.65s on
	// a live core). Raw single-byte keys on the same attach stream as the text
	// keep the order and apply at once.
	if raw, ok := coreRawKeys(command.Keys); ok && hello.has("terminal.get") && hello.has("terminal.attach") {
		channel, err := c.coreInput(ctx, conn, terminal, operation)
		if err != nil {
			return coreFailure(operationID, c.endCall(conn, operation, err, true, false))
		}
		if err := conn.TypeInput(channel, raw); err != nil {
			return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
		}
		return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityPane, ID: command.PaneID}}}, nil
	}
	keys, ok := canonicalSendKeys(command.Keys)
	if !ok {
		return notApplied(operationID, invalidFault(operation, "invalid key"))
	}
	if err := coreRequireMethod(hello, operation, "terminal.keys"); err != nil {
		return notApplied(operationID, err)
	}
	var result coreKeysResult
	if err := conn.Call(ctx, "terminal.keys", map[string]any{"terminal": terminal, "keys": keys}, &result); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityPane, ID: command.PaneID}}}, nil
}

func (c *Core) coreRenamePane(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command RenamePaneCommand) (Receipt, error) {
	const operation = "pane.rename"
	if command.PaneID == "" {
		return notApplied(operationID, invalidFault(operation, "pane id is required"))
	}
	terminal, err := decodeCorePaneID(command.PaneID)
	if err != nil {
		return notApplied(operationID, err)
	}
	if err := coreRequireMethod(hello, operation, "terminal.label"); err != nil {
		return notApplied(operationID, err)
	}
	label := ""
	if command.Label != nil {
		label = *command.Label
	}
	// Core stores the label as a terminal label; an empty value removes it.
	params := map[string]any{"terminal": terminal, "labels": map[string]string{corePaneLabelKey: label}}
	var updated coreTerminal
	if err := conn.Call(ctx, "terminal.label", params, &updated); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	if err := validateCoreTerminal(operation, updated); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	if updated.Address != terminal {
		err := coreProtocol(operation, "terminal core renamed a different terminal")
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityPane, ID: command.PaneID}}}, nil
}

func (c *Core) coreClosePane(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command ClosePaneCommand) (Receipt, error) {
	const operation = "pane.close"
	if command.PaneID == "" {
		return notApplied(operationID, invalidFault(operation, "pane id is required"))
	}
	terminal, err := decodeCorePaneID(command.PaneID)
	if err != nil {
		return notApplied(operationID, err)
	}
	if err := coreRequireMethod(hello, operation, "terminal.kill"); err != nil {
		return notApplied(operationID, err)
	}
	// The viewer must go before the program; a failed close frame is surfaced
	// by the kill call below rather than reported as a partial close.
	_ = c.closeCoreInput(terminal)
	gone := false
	var killed coreTerminal
	if err := conn.Call(ctx, "terminal.kill", map[string]any{"terminal": terminal}, &killed); err != nil {
		if !coreTerminalGone(err) {
			return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
		}
		gone = true
	} else if err := validateCoreTerminal(operation, killed); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	} else if killed.Address != terminal {
		err := coreProtocol(operation, "terminal core killed a different terminal")
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	outcome := OutcomeApplied
	if gone {
		outcome = OutcomeNoop
	}
	// Kill leaves the finished record behind; rm releases it. Cores without rm
	// still close: the live view stops listing the terminal.
	if hello.has("terminal.rm") {
		var removed coreRemoveResult
		switch err := conn.Call(ctx, "terminal.rm", map[string]any{"terminal": terminal}, &removed); {
		case err == nil && removed.Removed == "":
			protocolErr := coreProtocol(operation, "terminal core did not remove the terminal")
			return coreFailure(operationID, c.endCall(conn, operation, protocolErr, true, true))
		case err == nil:
			// The finished record is released.
		case coreTerminalGone(err):
			// A concurrent close released it first.
		case gone:
			// The terminal was already finished or absent; a lingering finished
			// record is not a pane the phone can see or open.
		default:
			fault := c.endCall(conn, operation, err, true, true)
			if mapped, ok := AsFault(fault); ok && mapped.Outcome == OutcomeNotApplied {
				// The program is gone but its record remains.
				mapped.Outcome = OutcomePartial
			}
			return receiptForError(operationID, fault), fault
		}
	}
	return Receipt{OperationID: operationID, Outcome: outcome, Removed: []EntityRef{{Kind: EntityPane, ID: command.PaneID}}}, nil
}

// coreTerminalGone reports an error that means the terminal is already
// absent or finished, which for a close is the requested end state.
func coreTerminalGone(err error) bool {
	var rpcErr *coreRPCError
	if !errors.As(err, &rpcErr) {
		return false
	}
	kind := strings.ToLower(strings.TrimSpace(rpcErr.Kind))
	return kind == "not_found" || kind == "finished"
}

func (c *Core) coreCreateConversation(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command CreateConversationCommand) (Receipt, error) {
	const operation = "create_conversation"
	// CreateConversationCommand carries no workspace, so a new conversation is
	// created on this computer. coreConversationParams already knows how to
	// target a remote machine once a workspace id is available.
	params, err := coreConversationParams(command, "")
	if err != nil {
		return notApplied(operationID, err)
	}
	if err := coreRequireMethod(hello, operation, "terminal.run"); err != nil {
		return notApplied(operationID, err)
	}
	var run coreRunResult
	if err := conn.Call(ctx, "terminal.run", params, &run); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	if !coreAddressPattern.MatchString(run.Address) {
		err := coreProtocol(operation, "invalid terminal core run response")
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	if target, _ := params["on"].(string); target != "" && coreMachineOf(run.Address) != target {
		err := coreProtocol(operation, "terminal core started the terminal on another machine")
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	paneID := encodeCoreAddress(run.Address)
	created := []EntityRef{
		{Kind: EntityWorkspace, ID: coreWorkspaceKey(run.Address)},
		{Kind: EntityTab, ID: coreTabPrefix + paneID},
		{Kind: EntityPane, ID: paneID},
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: created}, nil
}

func coreConversationParams(command CreateConversationCommand, workspaceID string) (map[string]any, error) {
	params := make(map[string]any, 4)
	if command.AgentKind != "" {
		params["argv"] = []string{command.AgentKind}
	}
	if command.CWD != "" {
		if !filepath.IsAbs(command.CWD) {
			return nil, invalidFault("create_conversation", "cwd must be absolute")
		}
		params["cwd"] = command.CWD
	}
	if command.Label != "" {
		params["labels"] = map[string]string{corePaneLabelKey: command.Label}
	}
	machine, err := coreMachineForWorkspace(workspaceID)
	if err != nil {
		return nil, err
	}
	if machine != "" {
		params["on"] = machine
	}
	return params, nil
}

func coreMachineForWorkspace(workspaceID string) (string, error) {
	if workspaceID == "" || workspaceID == coreLocalWorkspaceID {
		return "", nil
	}
	if machine := strings.TrimPrefix(workspaceID, coreMachinePrefix); machine != workspaceID {
		if coreAddressPartPattern.MatchString(machine) {
			return machine, nil
		}
	}
	return "", invalidFault("create_conversation", "invalid workspace id")
}

func (c *Core) corePromptAgent(ctx context.Context, conn coreTransport, hello coreHello, operationID string, command PromptAgentCommand) (Receipt, error) {
	const operation = "agent.prompt"
	if command.Target == "" || command.Text == "" {
		return notApplied(operationID, invalidFault(operation, "agent target and prompt are required"))
	}
	terminal, err := decodeCorePaneID(command.Target)
	if err != nil {
		return notApplied(operationID, err)
	}
	if err := coreRequireMethod(hello, operation, "terminal.send"); err != nil {
		return notApplied(operationID, err)
	}
	// terminal.send pastes the text and submits Enter in one core call. force
	// is only for this path: the phone user explicitly pressed send, and the
	// core otherwise refuses a blocked program that may be waiting on a dialog.
	// Automatic or retried sends must never force.
	var result coreSendResult
	params := map[string]any{"terminal": terminal, "text": command.Text, "force": true}
	if err := conn.Call(ctx, "terminal.send", params, &result); err != nil {
		return coreFailure(operationID, c.endCall(conn, operation, err, true, true))
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityPane, ID: command.Target}}}, nil
}

func coreUnsupportedCommand(command Command) error {
	switch command.(type) {
	case RenameTabCommand:
		return unsupported("tab.rename", "tab rename is unsupported by the terminal core")
	case RenameWorkspaceCommand:
		return unsupported("workspace.rename", "workspace rename is unsupported by the terminal core")
	case CloseTabCommand:
		return unsupported("tab.close", "tab close is unsupported by the terminal core")
	case CloseWorkspaceCommand:
		return unsupported("workspace.close", "workspace close is unsupported by the terminal core")
	case CreateTabCommand:
		return unsupported("tab.create", "tab create is unsupported by the terminal core")
	case SplitPaneCommand:
		return unsupported("pane.split", "pane split is unsupported by the terminal core")
	case WorktreeCreateCommand:
		return unsupported("worktree.create", "worktrees are unsupported by the terminal core")
	case WorktreeOpenCommand:
		return unsupported("worktree.open", "worktrees are unsupported by the terminal core")
	case ResizePaneCommand:
		return unsupported("pane.resize", "pane resize is unsupported by the terminal core")
	case SwapPaneCommand:
		return unsupported("pane.swap", "pane swap is unsupported by the terminal core")
	case ZoomPaneCommand:
		return unsupported("pane.zoom", "pane zoom is unsupported by the terminal core")
	default:
		return unsupported("execute", "unknown runtime command")
	}
}

type coreKindFault struct {
	code    ErrorCode
	message string
}

var coreKindFaults = map[string]coreKindFault{
	"not_found":              {CodeNotFound, "terminal not found"},
	"machine_unknown":        {CodeNotFound, "machine not found"},
	"invalid_params":         {CodeInvalid, "invalid request"},
	"invalid_template":       {CodeUnsupported, "agent kind is not available"},
	"name_taken":             {CodeConflict, "terminal name is taken"},
	"conflict":               {CodeConflict, "the terminal core reported a conflict"},
	"already_added":          {CodeConflict, "the terminal core already knows this machine"},
	"finished":               {CodeNotReady, "terminal has finished"},
	"blocked":                {CodeBlocked, "agent is blocked"},
	"status_mismatch":        {CodeStale, "terminal status changed"},
	"needs_framed":           {CodeUnsupported, "operation requires a framed terminal core connection"},
	"refused":                {CodeUnsupported, "the terminal core refused the operation"},
	"spawn_failed":           {CodeNotReady, "terminal could not start"},
	"unavailable":            {CodeNotReady, "terminal is unavailable"},
	"unsupported_generation": {CodeUnsupported, "terminal core protocol generation is unsupported"},
	"internal":               {CodeInternal, "the terminal core reported an internal error"},
	"io":                     {CodeInternal, "the terminal core reported an I/O error"},
	"config":                 {CodeInternal, "the terminal core reported a configuration error"},
}

func coreRPCFault(rpc *coreRPCError) (ErrorCode, string) {
	kind := strings.ToLower(strings.TrimSpace(rpc.Kind))
	if kind == "" {
		kind = strings.ToLower(strings.TrimSpace(rpc.Message))
	}
	if kind == "invalid_params" && strings.Contains(strings.ToLower(rpc.Message), "unknown key") {
		return CodeKey, "unknown key"
	}
	if mapped, ok := coreKindFaults[kind]; ok {
		return mapped.code, mapped.message
	}
	return CodeInternal, "the terminal core returned an unexpected error"
}

func coreFault(operation string, err error, mutating, sent bool) error {
	if err == nil {
		return nil
	}
	var existing *Fault
	if errors.As(err, &existing) {
		return existing
	}
	outcome := OutcomeNotApplied
	retry := RetryReadSafe
	if mutating {
		retry = RetryUserOnly
		if sent {
			outcome = OutcomeUnknown
		}
	}
	var rpcErr *coreRPCError
	if errors.As(err, &rpcErr) {
		code, message := coreRPCFault(rpcErr)
		return &Fault{Code: code, Operation: operation, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: message, Cause: err}
	}
	var streamErr *coreStreamClosedError
	if errors.As(err, &streamErr) {
		return &Fault{
			Code: CodeNotReady, Operation: operation, Outcome: OutcomeNotApplied,
			Retry: RetryNever, SafeMessage: "terminal input stream closed", Cause: err,
		}
	}
	code := CodeInternal
	message := "the terminal core returned an unexpected response"
	var transportErr *coreTransportError
	if errors.As(err, &transportErr) {
		code, message = CodeOffline, "the terminal core is offline"
		if transportErr.timeout || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			code, message = CodeTimeout, "the terminal core did not answer in time"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		code, message = CodeTimeout, "the terminal core did not answer in time"
	}
	return &Fault{Code: code, Operation: operation, Outcome: outcome, Retry: retry, SafeMessage: message, Cause: err}
}
