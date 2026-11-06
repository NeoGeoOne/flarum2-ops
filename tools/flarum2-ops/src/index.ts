#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clientFromEnv, createMcpServer, opsFromEnv } from "./server.js";
import { runHttp } from "./http.js";

function useHttp(): boolean {
  return process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";
}

async function runStdio(): Promise<void> {
  const client = clientFromEnv();
  const server = createMcpServer(client, opsFromEnv(client));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[flarum2-ops] connected to ${client.forumUrl} (stdio, ${client.readOnly ? "read-only" : "write"} mode)\n`);
}

async function main(): Promise<void> {
  if (useHttp()) {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(`[flarum2-ops] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
