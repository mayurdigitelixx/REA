import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { appleDispatchMetadataFailure } from "./AppleDispatchMetadata.js";

it.each(["integrity", "path"] as const)(
  "reports %s source-read refusals as changes to the bound metadata target",
  (reason) => {
    const cause = new ArtifactReaderFailure(reason, "source boundary refused");
    const failure = appleDispatchMetadataFailure(cause, "/selected");
    expect(failure).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      path: "/selected",
      reason: cause.message,
    });
    expect(failure.cause).toBe(cause);
  },
);
it.each(
  ["EACCES", "EPERM", "ENOENT"].flatMap((code) =>
    [false, true].map((wrapped) => ({ code, wrapped })),
  ),
)(
  "preserves $code for a bound metadata target (reader wrapper: $wrapped)",
  ({ code, wrapped }) => {
    const physical = Object.assign(new Error("selected read refused"), {
      code,
    });
    const cause = wrapped
      ? new ArtifactReaderFailure("io", "could not read", { cause: physical })
      : physical;
    const failure = appleDispatchMetadataFailure(cause, "/selected");
    expect(failure).toMatchObject({
      _tag:
        code === "ENOENT"
          ? "AnalysisArtifactChangedError"
          : "AnalysisAccessDeniedError",
      path: "/selected",
    });
    expect(failure.cause).toBe(cause);
    if (code === "ENOENT")
      expect(failure).toMatchObject({ reason: expect.stringContaining(code) });
    else expect(failure).toMatchObject({ systemCode: code });
  },
);
