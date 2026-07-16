import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index";

describe("@agentscout/client scaffold", () => {
  it("exports a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
