import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createServer } from "../../../src/server/createServer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { buildGamecubeDol } from "../../../src/domain/gamecubeDol.fixture.js";
import { silentLogger } from "../../../src/logger.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const connect = async () => {
  const session = createTestBinarySession(createCacheProvider([]));
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const client = new Client({ name: "dol-binary-session-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, tools: (await client.listTools()).tools };
};

const validateAdvertised = (
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: "open_binary" | "binary_session",
  response: CallToolResult,
) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool?.outputSchema === undefined)
    throw new Error(`missing ${name} output schema`);
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(z.record(z.string(), z.unknown()).parse(tool.outputSchema));
  expect(
    validate(response.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true);
  // The zod contract must accept the same payload the advertised JSON schema does.
  const parsed = toolContract(name).outputSchema.parse(
    response.structuredContent,
  );
  return z.record(z.string(), z.unknown()).parse(parsed.result);
};

it("opens a GameCube DOL and validates binary_session status against its output schema", async () => {
  const root = await createTestTempDirectory("rea-dol-session-mcp-");
  const path = join(root, "game.dol");
  await writeFile(path, buildGamecubeDol());
  const { client, tools } = await connect();

  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path, format: "gamecube-dol" },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  expect(validateAdvertised(tools, "open_binary", opened)).toMatchObject({
    format: "gamecube-dol",
    architecture: "powerpc",
    entry_point: "0x80003100",
  });

  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(status.isError, JSON.stringify(status)).not.toBe(true);
  expect(validateAdvertised(tools, "binary_session", status)).toMatchObject({
    format: "gamecube-dol",
    kind: "executable",
    architecture: "powerpc",
    entry_point: "0x80003100",
  });
});
