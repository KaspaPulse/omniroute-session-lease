import { CORS_HEADERS } from "../utils/cors.ts";
/**
 * Responses API Handler for Workers
 * Converts Chat Completions to Codex Responses API format
 */

import { handleChatCore } from "./chatCore.ts";
import { convertResponsesApiFormat } from "../translator/helpers/responsesApiHelper.ts";
import { createResponsesApiTransformStream } from "../transformer/responsesTransformer.ts";
import { createSseHeartbeatTransform, HEARTBEAT_SHAPES } from "../utils/sseHeartbeat.ts";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../config/constants.ts";

// OMNIROUTE_CODEX_STATUSLINE_RATE_LIMIT_FORWARDING
function buildCodexClientResponseHeaders(upstreamHeaders) {
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const name of [
    "x-codex-primary-used-percent",
    "x-codex-primary-window-minutes",
    "x-codex-primary-reset-at",
    "x-codex-secondary-used-percent",
    "x-codex-secondary-window-minutes",
    "x-codex-secondary-reset-at",
    "x-codex-credits-has-credits",
    "x-codex-credits-unlimited",
    "x-codex-credits-balance",
    "x-codex-limit-name",
    "x-codex-promo-message",
    "x-codex-rate-limit-reached-type",
  ]) {
    const value = upstreamHeaders.get(name);
    if (value != null && value !== "") headers.set(name, value);
  }

  const setLegacyWindow = (modernPrefix, usageName, limitName, resetName, windowMinutes) => {
    const usedHeader = `${modernPrefix}-used-percent`;
    const windowHeader = `${modernPrefix}-window-minutes`;
    const resetHeader = `${modernPrefix}-reset-at`;

    if (!headers.has(usedHeader)) {
      const usage = Number(upstreamHeaders.get(usageName));
      const limit = Number(upstreamHeaders.get(limitName));
      if (Number.isFinite(usage) && Number.isFinite(limit) && limit > 0) {
        headers.set(usedHeader, String(Math.max(0, Math.min(100, (usage / limit) * 100))));
      }
    }
    if (!headers.has(windowHeader)) headers.set(windowHeader, String(windowMinutes));
    if (!headers.has(resetHeader)) {
      const reset = upstreamHeaders.get(resetName);
      if (reset) {
        const ms = Date.parse(reset);
        if (Number.isFinite(ms)) headers.set(resetHeader, String(Math.floor(ms / 1000)));
      }
    }
  };

  setLegacyWindow(
    "x-codex-primary",
    "x-codex-5h-usage",
    "x-codex-5h-limit",
    "x-codex-5h-reset-at",
    300
  );
  setLegacyWindow(
    "x-codex-secondary",
    "x-codex-7d-usage",
    "x-codex-7d-limit",
    "x-codex-7d-reset-at",
    10080
  );
  return headers;
}

/**
 * Handle /v1/responses request
 * @param {object} options
 * @param {object} options.body - Request body (Responses API format)
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} options.log - Logger instance (optional)
 * @param {function} options.onCredentialsRefreshed - Callback when credentials are refreshed
 * @param {function} options.onRequestSuccess - Callback when request succeeds
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {AbortSignal} [options.signal] - Abort signal for request/disconnect cleanup
 * @returns {Promise<{success: boolean, response?: Response, status?: number, error?: string}>}
 */
export async function handleResponsesCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  onDisconnect,
  connectionId,
  signal,
}) {
  // Convert Responses API format to Chat Completions format
  const convertedBody = convertResponsesApiFormat(body, credentials);

  // Ensure stream is enabled
  convertedBody.stream = true;

  // Call chat core handler
  const result = await handleChatCore({
    body: convertedBody,
    modelInfo,
    credentials,
    log,
    onCredentialsRefreshed,
    onRequestSuccess,
    onDisconnect,
    clientRawRequest: null,
    connectionId,
    userAgent: null,
    comboName: null,
  });

  if (!result.success || !result.response) {
    return result;
  }

  const response = result.response;
  const contentType = response.headers.get("Content-Type") || "";

  // If not SSE or error, return as-is
  if (!contentType.includes("text/event-stream") || response.status !== 200) {
    return result;
  }

  // Transform SSE stream to Responses API format (no logging in worker)
  const transformStream = createResponsesApiTransformStream(null);
  const transformedBody = response.body.pipeThrough(transformStream).pipeThrough(
    createSseHeartbeatTransform({
      signal,
      intervalMs: SSE_HEARTBEAT_INTERVAL_MS,
      shape: HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS,
    })
  );

  return {
    success: true,
    response: new Response(transformedBody, {
      status: 200,
      headers: buildCodexClientResponseHeaders(response.headers),
    }),
  };
}
