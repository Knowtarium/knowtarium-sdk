import { z } from "zod";

/*
 * zod compiles a fast path for object schemas with `new Function`, and probes whether it may. A
 * strict Content Security Policy (the web app's) reports even the probe as a violation, so the
 * protocol turns that off before any of its schemas exist: `index.ts` imports this module first.
 * The setting is zod's global config, so it also applies to schemas the app builds itself.
 */
z.config({ jitless: true });

/** Whether zod runs without compiling code (always true once the protocol is loaded). */
export function isJitless(): boolean {
  return z.config().jitless === true;
}
