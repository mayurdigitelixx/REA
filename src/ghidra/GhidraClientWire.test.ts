import type { Socket } from "node:net";

import pino from "pino";
import { describe, expect, it } from "vitest";

import type { BridgeMaxRequestBytes } from "../config/bridgeMaxRequestBytes.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import { PendingOperations } from "../process/PendingOperations.js";
import { GhidraWire } from "./GhidraClientWire.js";
import {
  bindGhidraSessionFailure,
  type GhidraSessionError,
} from "./GhidraSessionError.js";

const failure = bindGhidraSessionFailure(() => ({
  target_path: "/tmp/wire-fixture",
}));

const limit = (maximumBytes: number): BridgeMaxRequestBytes => ({
  maximumBytes,
  source: "setting",
});

type WireHarness = {
  readonly writes: string[];
  readonly pending: PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >;
  readonly wire: GhidraWire;
};

const harness = (ceiling: BridgeMaxRequestBytes): WireHarness => {
  const writes: string[] = [];
  const socket = {
    destroyed: false,
    write: (payload: string, callback?: (cause?: Error | null) => void) => {
      writes.push(payload);
      callback?.(null);
      return true;
    },
  } as unknown as Socket;
  const pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  return {
    writes,
    pending,
    wire: new GhidraWire({
      getSocket: () => socket,
      getToken: () => "b".repeat(64),
      nextId: () => 1,
      pending,
      logger: pino({ level: "silent" }),
      failure,
      bridgeMaxRequestBytes: ceiling,
    }),
  };
};

describe("GhidraWire request ceiling", () => {
  it("refuses an oversized request before any socket write", async () => {
    const { writes, wire } = harness(limit(8192));

    const refused = await wire.request(
      "search_strings",
      { pattern: "n".repeat(9000) },
      {},
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
    expect(refused.error.message).toContain("8192");
    expect(refused.error.message).toContain("Ghidra request exceeds");
    expect(refused.error.cause).toBeInstanceOf(AnalysisResourceConstraintError);
    const constraint = refused.error.cause;
    if (!(constraint instanceof AnalysisResourceConstraintError)) return;
    expect(constraint.reportedLimits).toMatchObject({
      max_request_bytes: 8192,
      payload_bytes: expect.any(Number),
    });
    const payloadBytes = constraint.reportedLimits?.payload_bytes;
    expect(typeof payloadBytes).toBe("number");
    expect(payloadBytes as number).toBeGreaterThan(8192);
    expect(constraint.retryable).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes a request that stays at or below the ceiling", async () => {
    const { writes, pending, wire } = harness(limit(16 * 1024 * 1024));

    const dispatched = wire.request(
      "search_strings",
      { pattern: "fixture" },
      {},
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"search_strings"');
    expect(writes[0]?.endsWith("\n")).toBe(true);
    pending.settle(1, ok("ok"));
    await expect(dispatched).resolves.toMatchObject({ ok: true, value: "ok" });
  });

  it("keeps the refusal out of the pending-operation registry", async () => {
    const { pending, wire } = harness(limit(7464));

    await wire.request("search_strings", { pattern: "x".repeat(20_000) }, {});

    expect(pending.has(1)).toBe(false);
  });
});
