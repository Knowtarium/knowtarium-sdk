import { accountRoutes } from "./account.js";
import { agentPolicyRoutes } from "./agent-policy.js";
import { attachmentRoutes } from "./attachments.js";
import { authRoutes } from "./auth.js";
import { changeRoutes } from "./changes.js";
import { checkRoutes } from "./checks.js";
import { commentRoutes } from "./comments.js";
import { connectRoutes } from "./connect.js";
import { eventRoutes } from "./events.js";
import { folderRoutes } from "./folders.js";
import { healthRoutes } from "./health.js";
import { historyRoutes } from "./history.js";
import { keyRoutes } from "./keys.js";
import { liveRoutes } from "./live.js";
import { noteRoutes } from "./notes.js";
import { pendingRoutes } from "./pending.js";
import { planRoutes } from "./plans.js";
import type { RouteBase } from "./route.js";
import { tokenRoutes } from "./tokens.js";
import { workspaceRoutes } from "./workspaces.js";

/**
 * Every route of the sync API, by name. The server registers each one (Hono takes the path
 * templates as they are) and validates with its schemas; clients build requests from the same
 * entries with `pathFor`.
 */
export const routes = {
  ...healthRoutes,
  ...authRoutes,
  ...accountRoutes,
  ...planRoutes,
  ...keyRoutes,
  ...workspaceRoutes,
  ...folderRoutes,
  ...changeRoutes,
  ...noteRoutes,
  ...historyRoutes,
  ...attachmentRoutes,
  ...pendingRoutes,
  ...agentPolicyRoutes,
  ...eventRoutes,
  ...commentRoutes,
  ...checkRoutes,
  ...tokenRoutes,
  ...connectRoutes,
  ...liveRoutes,
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

/** `"GET /workspaces/:workspaceId"`: a route's method and path, unique across the table. */
export function routeKey(route: Pick<RouteBase, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}

/** The route table as a list, for registering every route in a loop. */
export const ROUTE_LIST: readonly (RouteBase & { name: RouteName })[] = (
  Object.keys(routes) as RouteName[]
).map((name) => ({ ...routes[name], name }));
