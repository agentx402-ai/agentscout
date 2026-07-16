import { describe, expect, it } from "vitest";
import { scoutErrorFromResponse } from "../src/errors";

describe("scoutErrorFromResponse", () => {
  it("maps a worker { error, code, hint } body to a typed AgentScoutError", () => {
    const e = scoutErrorFromResponse(
      422,
      JSON.stringify({
        error: "page had no extractable text",
        code: "thin_content",
        hint: "try fresh=true",
      }),
      "read failed",
    );
    expect(e.code).toBe("thin_content");
    expect(e.status).toBe(422);
    expect(e.hint).toBe("try fresh=true");
    expect(e.message).toContain("page had no extractable text");
  });

  it("falls back to request_failed on a non-JSON body, keeping the status + fallback label", () => {
    const e = scoutErrorFromResponse(500, "<html>502 bad gateway</html>", "read failed");
    expect(e.code).toBe("request_failed");
    expect(e.status).toBe(500);
    expect(e.message).toContain("read failed");
  });

  it.each([
    ["invalid_request", 400],
    ["conflicting_auth", 400],
    ["toll_too_large", 400],
    ["tolls_require_x402", 402],
    ["insufficient_credits", 402],
    ["payment_required", 402],
    ["payee_sanctioned", 403],
    ["not_found", 404],
    ["method_not_allowed", 405],
    ["duplicate_in_flight", 409],
    ["schema_too_large", 413],
    ["thin_content", 422],
    ["extraction_failed", 422],
    ["rate_limited", 429],
    ["internal_error", 500],
    ["upstream_unavailable", 503],
  ])("preserves worker code %s with status %i", (code, status) => {
    const e = scoutErrorFromResponse(status, JSON.stringify({ error: code, code }), "op failed");
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });
});
