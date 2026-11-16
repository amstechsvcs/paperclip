// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { RunsTab } from "./AgentDetail";
import { RunsTab as ProductionRunsTab } from "./AgentDetail.production";
import { ToastProvider } from "../context/ToastContext";
import { PanelProvider } from "../context/PanelContext";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get, events: async () => [], workspaceOperations: async () => [] } }));
vi.mock("../api/client", () => ({ api: { get: async () => [] }, detachInflightGet: vi.fn() }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); });

// PRO-909: a run killed by context compaction carries `context_compaction_failed`,
// not an auth problem. The generic error row (error + code) must stay, and the
// Claude login affordance must appear only for `claude_auth_required`.
it.each([
  { Tab: RunsTab, errorCode: "context_compaction_failed", showsLogin: false },
  { Tab: ProductionRunsTab, errorCode: "context_compaction_failed", showsLogin: false },
  { Tab: RunsTab, errorCode: "claude_auth_required", showsLogin: true },
  { Tab: ProductionRunsTab, errorCode: "claude_auth_required", showsLogin: true },
])("renders run error affordance for $errorCode (%#)", async ({ Tab, errorCode, showsLogin }) => {
  const run = { id: "failed-run", companyId: "company-1", agentId: "agent-1", issueId: "issue-1", status: "failed", invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 1, error: "Prompt is too long · automatic compaction failed: context window exceeded",
    errorCode, logRef: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
      <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId={run.id} adapterType="claude_local" adapterConfig={{}} />
    </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain("failed"); });
    expect(element.textContent).toContain("Prompt is too long · automatic compaction failed: context window exceeded");
    expect(element.textContent).toContain(`(${errorCode})`);
    const loginButton = Array.from(element.querySelectorAll("button"))
      .find((button) => button.textContent === "Login to Claude Code");
    // The static affordance is the button; the login URL only renders after the
    // mutation resolves, so its absence here is not part of this boundary.
    expect(loginButton !== undefined).toBe(showsLogin);
    expect(element.textContent!.includes("Login URL:")).toBe(false);
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});
