import { expect, it } from "vitest";
import { appleIpsSchema, inspectAppleIpsInputSchema } from "./appleIps.js";

it("rejects extra caller arguments and admits an empty crash inventory", () => {
  expect(
    inspectAppleIpsInputSchema.safeParse({
      path: "/artifacts/report.ips",
      extra: true,
    }).success,
  ).toBe(false);
  const report = appleIpsSchema.parse({
    artifact: {
      path: "/artifacts/report.ips",
      sha256: "a".repeat(64),
      bytes: 128,
    },
    metadata: {
      bug_type: "309",
      timestamp: null,
      os_version: null,
      bundle_id: null,
      incident_id: null,
      name: null,
      unlisted_keys: [],
    },
    process: {
      name: null,
      path: null,
      pid: null,
      parent: null,
      cpu_type: null,
      translated: null,
      os_version: null,
    },
    exception: null,
    termination: null,
    faulting_thread: null,
    threads: [],
    images: [],
    classification: { status: "unclassified", matches: [] },
    coverage: {
      status: "complete",
      reason: null,
      threads: 0,
      frames: 0,
      images: 0,
      registers: 0,
      type_mismatches: [],
    },
    unlisted_body_keys: [],
    limitations: ["Opened Mach-O and dSYM UUID joins remain unobserved."],
  });
  expect(report.metadata.bug_type).toBe("309");
  expect(report.classification.status).toBe("unclassified");
});
