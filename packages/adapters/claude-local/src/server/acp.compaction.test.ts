import { describe, expect, it } from "vitest";
import { classifyClaudeTerminalSessionFailure } from "./acp.js";

const now = new Date("2026-11-16T12:00:00.000Z");

const COMPACTION_TITLE =
  "Prompt is too long · automatic compaction failed: summarization produced empty response";

describe("classifyClaudeTerminalSessionFailure context compaction", () => {
  it("classifies a typed compaction failure ahead of the access category", () => {
    // The incident: the provider typed the death as access because the
    // diagnostic text repeats auth words, but the run died summarizing an
    // oversized prompt. Compaction wins; no login gate.
    expect(classifyClaudeTerminalSessionFailure({
      category: "access",
      title: COMPACTION_TITLE,
    }, now)).toEqual({ errorCode: "context_compaction_failed" });
  });

  it("classifies a compaction death typed as limit", () => {
    expect(classifyClaudeTerminalSessionFailure({
      category: "limit",
      title: COMPACTION_TITLE,
    }, now)).toEqual({ errorCode: "context_compaction_failed" });
  });

  it("reads the compaction pattern from details with auth prose in the title", () => {
    expect(classifyClaudeTerminalSessionFailure({
      category: "unknown",
      title: "Claude needs login to continue",
      details: COMPACTION_TITLE,
    }, now)).toEqual({ errorCode: "context_compaction_failed" });
  });

  it("keeps a plain typed access failure on the sign-in recovery path", () => {
    expect(classifyClaudeTerminalSessionFailure({
      category: "access",
      title: "Please run `claude login` to authenticate.",
    }, now)).toEqual({ errorCode: "acpx_auth_required" });
  });

  it("keeps the generic typed access fallback on the sign-in recovery path", () => {
    expect(classifyClaudeTerminalSessionFailure({
      category: "access",
      title: "ACP agent reported a terminal access failure.",
    }, now)).toEqual({ errorCode: "acpx_auth_required" });
  });

  it("keeps an unrelated typed request failure unclassified", () => {
    expect(classifyClaudeTerminalSessionFailure({
      category: "request",
      title: "Invalid request payload rejected",
      details: "The request schema rejected field 'context'",
    }, now)).toBeNull();
  });
});
