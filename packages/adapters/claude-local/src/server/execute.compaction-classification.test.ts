import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { detectClaudeContextCompaction } from "./parse.js";

// The observed incident wording. The compaction summary repeats auth-like
// words in its surroundings, so a compaction death also trips the legacy
// login-prompt markers.
const COMPACTION_MESSAGE =
  "Prompt is too long · automatic compaction failed: summarization produced empty response";

// Tool output the agent itself printed. It carries the compaction phrase as
// ordinary prose, but the provider never returned it.
const POISONED_TOOL_OUTPUT = `grep -rn "prompt is too long" runtime/`;

// The real Claude CLI output for an oversized prompt: the result event carries
// the compaction message, and the CLI also prints an auth phrase nearby, which
// is the incident's false claude_auth_required source.
const COMPACTION_RESULT_EVENT = {
  is_error: true,
  subtype: "error_during_execution",
  result: `${COMPACTION_MESSAGE}\n authentication required, please log in with /login`,
};

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local context compaction classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports context_compaction_failed over the login prompt when both patterns appear", async () => {
    // The incident: the compaction message sits next to auth wording, so the
    // legacy login-prompt markers fire too. Compaction must win.
    mockExecutionResult(buildProcResult(COMPACTION_RESULT_EVENT));

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("context_compaction_failed");
  });

  it("reports context_compaction_failed from the errors array alone", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_during_execution",
        errors: [{ message: "automatic compaction failed: summarization produced empty response" }],
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("context_compaction_failed");
  });

  it("reports context_compaction_failed on the unparsed path from the terminal result line", async () => {
    // No parseable JSONL stream at all — the raw stdout still carries the
    // terminal result event line, so the unparsed detector reads it.
    const stdout = [
      "Prompt is too long · automatic compaction failed",
      JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: COMPACTION_MESSAGE }),
    ].join("\n");
    runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
      args.includes("--version")
        ? { exitCode: 0, signal: null, timedOut: false, stdout: "2.1.284 (Claude Code)", stderr: "", pid: 321, startedAt: new Date().toISOString() }
        : { exitCode: 1, signal: null, timedOut: false, stdout, stderr: "", pid: 321, startedAt: new Date().toISOString() },
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("context_compaction_failed");
  });

  it("still reports claude_auth_required for a real login prompt without a compaction pattern", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_during_execution",
        result: "Please run `claude login` to authenticate.",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("still reports claude_auth_required for a real token failure without a compaction pattern", async () => {
    mockExecutionResult(
      buildProcResult({
        is_error: true,
        subtype: "error_during_execution",
        api_error_status: 401,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });

  it("does not classify compaction from model prose in stdout", async () => {
    // The model quoted the compaction phrase in its own answer, but the run's
    // terminal result is a genuine auth prompt. The untrusted stdout must not
    // flip the classifier.
    mockExecutionResult(
      buildProcResult(
        {
          is_error: true,
          subtype: "error_during_execution",
          result: "Please run `claude login` to authenticate.",
        },
        `The tool printed: ${COMPACTION_MESSAGE}`,
      ),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});

describe("detectClaudeContextCompaction trust boundary", () => {
  it("matches the parsed terminal result fields", () => {
    expect(detectClaudeContextCompaction({
      parsed: { is_error: true, result: COMPACTION_MESSAGE },
    })).toBe(true);
  });

  it("matches the process stderr", () => {
    expect(detectClaudeContextCompaction({
      stderr: `claude: ${COMPACTION_MESSAGE}`,
    })).toBe(true);
  });

  it("ignores the raw stdout when no result event carries the phrase", () => {
    expect(detectClaudeContextCompaction({
      parsed: null,
      stdout: `assistant said: ${COMPACTION_MESSAGE}`,
      stderr: "",
    })).toBe(false);
  });

  it("reads a terminal result line from raw stdout on the unparsed path", () => {
    expect(detectClaudeContextCompaction({
      parsed: null,
      stdout: JSON.stringify({ type: "result", is_error: true, result: COMPACTION_MESSAGE }),
      stderr: "",
    })).toBe(true);
  });

  it("stays false for a clean run", () => {
    expect(detectClaudeContextCompaction({
      parsed: { is_error: false, subtype: "success", result: "done" },
    })).toBe(false);
  });
});
