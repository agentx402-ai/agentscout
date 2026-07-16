// Back-compat / single-import surface over @agentx402-ai/core's caller-side x402 helpers.
// The SDK pays THROUGH these — it never wires x402Client/ExactEvmScheme itself.
export {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  decodeBase64Utf8,
  freshNonce,
  nonceFromIdempotencyKey,
  type Signer,
} from "@agentx402-ai/core";
