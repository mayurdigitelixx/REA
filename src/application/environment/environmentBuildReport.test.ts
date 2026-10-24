import { describe, expect, it } from "vitest";

import { scenarioCaptureFixture } from "../../../tests/fixtures/browserScenarioCapture.js";
import { scenarioCaptureRecords } from "../../domain/analysisView/scenarioCaptureRecords.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import {
  anonymousOrigin,
  credentialNamed,
  nameFromCaptureFile,
  scanCredentialNames,
} from "./environmentBuildReport.js";

const record = (
  ordinal: number,
  request: unknown,
  response: unknown,
): WebNetworkCaptureRecord =>
  ({
    ordinal,
    reported: {
      request: {
        method: "POST",
        url: "http://127.0.0.1/api",
        ...(request === undefined
          ? {}
          : {
              postData: {
                mimeType: "application/json",
                text: JSON.stringify(request),
              },
            }),
      },
      response: {
        status: 200,
        content: {
          mimeType: "application/json",
          text: JSON.stringify(response),
        },
      },
    },
    redactions: [],
    binary_fields: [],
  }) as unknown as WebNetworkCaptureRecord;

describe("credentialNamed", () => {
  it("matches whole name segments, not substrings", () => {
    for (const name of [
      "password",
      "authToken",
      "api_key",
      "apiKey",
      "sessionId",
      "client_secret",
      "X-Session",
      "refresh.token",
      "Authorization",
      "APIToken",
      "accesstoken",
      "passphrase",
      "api_keys",
      "ssh_key",
    ])
      expect(credentialNamed(name), name).toBe(true);
    for (const name of ["author", "authority_level", "keyboard", "tokenizer"])
      expect(credentialNamed(name), name).toBe(false);
  });
});

describe("scanCredentialNames", () => {
  it("counts string values under credential names in request and response bodies, by pointer and never by value", () => {
    const scanned = scanCredentialNames([
      record(
        3,
        { name: "Folder", secret: "s3cr3t-value" },
        { data: [{ id: 1, sessionId: "abc123def" }], hasPassword: true },
      ),
      record(4, undefined, { token: "", "a/b": { apiKey: "k-1" } }),
    ]);
    expect(scanned).toEqual({
      count: 3,
      pointers: [
        "record 3 request /secret",
        "record 3 response /data/0/sessionId",
        "record 4 response /a~1b/apiKey",
      ],
    });
    expect(JSON.stringify(scanned)).not.toContain("s3cr3t");
  });

  it("scans header and query names, form bodies and string arrays", () => {
    const withHeaders = {
      ordinal: 7,
      reported: {
        request: {
          method: "POST",
          url: "http://127.0.0.1/api?api_key=k&page=1",
          headers: [
            { name: "X-Api-Key", value: "k-123" },
            { name: "Accept", value: "application/json" },
            { name: "Authorization", value: null },
          ],
          queryString: [
            { name: "api_key", value: "k" },
            { name: "page", value: "1" },
          ],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "user=a&password=hunter22",
          },
        },
        response: {
          status: 200,
          headers: [{ name: "X-Auth-Token", value: "t-9" }],
          content: {
            mimeType: "application/json",
            text: JSON.stringify({ tokens: ["a", "b"], token_count: 2 }),
          },
        },
      },
      redactions: [],
      binary_fields: [],
    } as unknown as WebNetworkCaptureRecord;
    expect(scanCredentialNames([withHeaders])).toEqual({
      count: 5,
      pointers: [
        "record 7 request header X-Api-Key",
        "record 7 response header X-Auth-Token",
        "record 7 request query api_key",
        "record 7 request /password",
        "record 7 response /tokens",
      ],
    });
  });

  it("counts every occurrence of a repeated form field that holds a value", () => {
    const form = (text: string): WebNetworkCaptureRecord => {
      const scanned = record(3, undefined, undefined);
      (
        scanned.reported as { request: { postData?: unknown } }
      ).request.postData = {
        mimeType: "application/x-www-form-urlencoded",
        text,
      };
      return scanned;
    };
    // A later empty occurrence does not hide the earlier value the Evidence ships.
    expect(scanCredentialNames([form("api_key=secret&api_key=")])).toEqual({
      count: 1,
      pointers: ["record 3 request /api_key"],
    });
    expect(scanCredentialNames([form("token=a&page=1&token=b")])).toEqual({
      count: 2,
      pointers: ["record 3 request /token", "record 3 request /token"],
    });
  });

  it("scans a scenario request body the capture recorded without a media type", () => {
    const capture = scenarioCaptureFixture(
      [
        {
          method: "POST",
          url: "/api/session",
          status: 200,
          mediaType: "application/json",
          body: "{}",
          requestBody: '{"password":"x"}',
        },
      ],
      { request_body: true, response_body: true, header_values: true },
    );
    expect(
      scanCredentialNames(scenarioCaptureRecords(capture, "review").records),
    ).toEqual({ count: 1, pointers: ["record 0 request /password"] });
  });

  it("walks bodies nested deeper than the call stack allows", () => {
    const depth = 20_000;
    const deep = record(1, undefined, undefined);
    (
      deep.reported as { response: { content: { text: string } } }
    ).response.content.text =
      `${"[".repeat(depth)}{"token":"x"}${"]".repeat(depth)}`;
    expect(scanCredentialNames([deep]).count).toBe(1);
  });
});

describe("anonymousOrigin", () => {
  it("is true for loopback names and IP literals", () => {
    for (const origin of [
      "http://127.0.0.1:3101",
      "http://localhost:3000",
      "http://app.localhost",
      "http://[::1]:8080",
      "http://10.0.0.5",
    ])
      expect(anonymousOrigin(origin), origin).toBe(true);
    expect(anonymousOrigin("http://localhost.:3000")).toBe(true);
    for (const origin of ["https://grafana.example", "not a url"])
      expect(anonymousOrigin(origin), origin).toBe(false);
  });
});

describe("nameFromCaptureFile", () => {
  it("drops capture suffixes and keeps a kebab-case label", () => {
    expect(nameFromCaptureFile("/w/grafana.har")).toBe("grafana");
    expect(nameFromCaptureFile("/w/grafana.capture.json")).toBe("grafana");
    expect(nameFromCaptureFile("/w/My App.scoped.HAR")).toBe("my-app-scoped");
    expect(nameFromCaptureFile("/w/--.json")).toBe("");
  });
});
