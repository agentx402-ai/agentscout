import { AgentXError } from "@agentx402-ai/core";
import { describe, expect, it } from "vitest";
import { AgentScoutError, SpendCapError } from "../src/index";

describe("AgentScout error taxonomy", () => {
  it("re-exports the SAME core AgentXError class (cross-package instanceof holds)", async () => {
    const core = await import("@agentx402-ai/core");
    expect(AgentXError).toBe(core.AgentXError);
    expect(new SpendCapError("x")).toBeInstanceOf(core.AgentXError);
  });

  it("AgentScoutError carries code, status, and hint", () => {
    const e = new AgentScoutError("thin", "thin_content", 422, "page had no body text");
    expect(e).toBeInstanceOf(AgentXError);
    expect(e.code).toBe("thin_content");
    expect(e.status).toBe(422);
    expect(e.hint).toBe("page had no body text");
    expect(e.name).toBe("AgentScoutError");
  });
});
