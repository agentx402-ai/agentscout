import { AgentXError, SpendCapError } from "@agentx402-ai/core";

// RE-EXPORT core's base + spend-cap error — never re-declare them, or cross-package
// `instanceof` breaks (two distinct class objects in node_modules).
export { AgentXError, SpendCapError };

/**
 * The worker's `{ error, code, hint }` responses map to this single class.
 * Subclassing core's base is allowed; re-declaring the base is not.
 * Callers branch on `e.code` (never on the class) — see ScoutErrorCode.
 */
export class AgentScoutError extends AgentXError {
  constructor(
    message: string,
    code: string,
    status?: number,
    readonly hint?: string,
  ) {
    super(message, code, status);
    this.name = "AgentScoutError";
  }
}

/** The full set of `code` strings the worker + SDK emit (spec Error taxonomy). */
export type ScoutErrorCode =
  | "invalid_request"
  | "conflicting_auth"
  | "toll_too_large"
  | "tolls_require_x402"
  | "insufficient_credits"
  | "payment_required"
  | "payee_sanctioned"
  | "not_found"
  | "method_not_allowed"
  | "duplicate_in_flight"
  | "schema_too_large"
  | "thin_content"
  | "extraction_failed"
  // async extract job: the failure code (server-supplied or the SDK default) and the
  // client-side poll timeout
  | "extract_failed"
  | "extract_job_timeout"
  | "rate_limited"
  | "internal_error"
  | "upstream_unavailable"
  // generic fallback in scoutErrorFromResponse when the response body carries no `code`
  | "request_failed"
  // transport, from the core fetch/retry layer:
  | "network_error"
  | "aborted"
  // client-side, pre-request/pre-sign — the core x402/EIP-712 payment guards throw these BEFORE
  // any signature, so a spoofed / mismatched / hostile challenge is rejected, never signed:
  | "payto_mismatch"
  | "spend_cap_exceeded"
  | "unpinned_network"
  | "unsupported_network"
  | "network_mismatch"
  | "asset_mismatch"
  | "domain_mismatch"
  | "invalid_challenge"
  | "invalid_amount"
  | "crawl_errored"
  // crawl dead-lettered before it could start (queue delivery exhausted) — terminal, distinct
  // from crawl_errored (which means the crawl ran and blew up). The worker's own status-poll
  // `code`, forwarded verbatim; refunded_credits/hint on the body cover the refund.
  | "job_dropped"
  | "invalid_config";

/**
 * Map a worker HTTP response body to a typed error. Shared by every verb's failure path
 * (a real Response via AgentScout.asError, and the CLI/MCP boundaries).
 * Preserves the worker's `code` (else "request_failed") and `hint`; message is
 * `AgentScout ${status}: ${detail}` where detail is the body's `error` or the fallback label.
 */
export function scoutErrorFromResponse(
  status: number,
  bodyText: string,
  fallback: string,
): AgentScoutError {
  let detail = fallback;
  let code = "request_failed";
  let hint: string | undefined;
  try {
    const body = JSON.parse(bodyText) as { error?: string; code?: string; hint?: string };
    if (body?.error) detail = body.error;
    if (body?.code) code = body.code;
    if (body?.hint) hint = body.hint;
  } catch {
    /* non-JSON body — keep fallback + request_failed */
  }
  return new AgentScoutError(`AgentScout ${status}: ${detail}`, code, status, hint);
}
