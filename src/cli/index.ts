#!/usr/bin/env node
// The `knowtarium` binary. Commands live in commands/, the connect flow in connect/, storage in
// storage/, agent config writers in agents/ and the MCP server in mcp/.
import process from "node:process";

import pkg from "../../package.json" with { type: "json" };
import { createCliContext } from "./context.js";
import { terminalIo } from "./io.js";
import { runCli } from "./run.js";

const io = terminalIo();
const code = await runCli(
  process.argv.slice(2),
  () => createCliContext(io, pkg.version),
  io,
  pkg.version,
);
process.exit(code);
