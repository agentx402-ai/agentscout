import { bytesToHex } from "viem";

export const AK_PREFIX = "ak_";
export const AK_RANDOM_BYTES = 32;

// `ak_` + 64 lowercase hex chars (= AK_RANDOM_BYTES * 2).
const AK_FORMAT_RE = /^ak_[0-9a-f]{64}$/;

export function generateAccountKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AK_RANDOM_BYTES));
  return AK_PREFIX + bytesToHex(bytes).slice(2);
}

export function isAccountKeyFormat(s: unknown): s is string {
  return typeof s === "string" && AK_FORMAT_RE.test(s);
}
