import { z } from "zod";

import { defineRoute } from "./route.js";

export const HealthResponse = z.object({
  ok: z.literal(true),
  protocolVersion: z.int().positive(),
  supportedProtocolVersions: z.array(z.int().positive()),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const healthRoutes = {
  health: defineRoute({
    method: "GET",
    path: "/health",
    auth: "none",
    summary: "Liveness and the protocol versions the API accepts",
    response: HealthResponse,
  }),
};
