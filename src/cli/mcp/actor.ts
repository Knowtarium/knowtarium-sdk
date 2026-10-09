import { type Actor, isActor } from "../../core/index.js";

/**
 * The agent's OKF actor (`<producer>/<version>`, as `generated.by` and `verified[].by` write it),
 * from the MCP client's handshake (`clientInfo.name` and `version`, for example
 * `claude-code/2.1.0`), else `knowtarium-cli/<version>`. An `--actor` override wins, but never a
 * `human:` one: agents don't sign as people.
 */
export function agentActor(
  client: { readonly name?: string; readonly version?: string } | undefined,
  cliVersion: string,
  override?: string,
): Actor {
  if (override !== undefined && isActor(override) && !override.startsWith("human:"))
    return override;
  const clean = (text: string | undefined) =>
    (text ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\w.+-]+/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "");
  const candidate = `${clean(client?.name)}/${clean(client?.version) || "0"}`;
  return isActor(candidate) ? candidate : (`knowtarium-cli/${cliVersion}` as Actor);
}
