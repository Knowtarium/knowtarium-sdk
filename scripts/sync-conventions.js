// Copies skills/knowtarium-conventions/SKILL.md into src/cli/mcp/conventions.ts, so the MCP server
// can serve the conventions to every client (`get_conventions`, a prompt and a resource) without
// reading files at run time, whatever the install (npm, the .mcpb bundle, the Claude plugin).
// Run it after editing the skill: `node scripts/sync-conventions.js`. A test fails when the two
// differ.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const skill = readFileSync(join(root, "skills", "knowtarium-conventions", "SKILL.md"), "utf8");
const source = `// Generated from skills/knowtarium-conventions/SKILL.md by scripts/sync-conventions.js; don't edit.

/** The knowtarium-conventions skill, served by the MCP server to every client. */
export const CONVENTIONS_SKILL =
  ${JSON.stringify(skill)};
`;
writeFileSync(join(root, "src", "cli", "mcp", "conventions.ts"), source);
process.stdout.write("wrote src/cli/mcp/conventions.ts\n");
