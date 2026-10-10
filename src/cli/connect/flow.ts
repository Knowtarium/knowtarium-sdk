import {
  createAgentKeyPair,
  createAgentSigningKeyPair,
  createConnectSecret,
  toBase64Url,
} from "../../crypto/index.js";
import {
  CONNECT_PAGE_PATH,
  formatConnectFragment,
  type LoopbackResponse,
  routes,
} from "../../protocol/index.js";
import {
  createApiClient,
  type FetchLike,
  isSyncApiError,
  isVaultError,
  NetworkError,
  type Scheduler,
  systemScheduler,
  type TrustState,
} from "../../client/index.js";
import type { Connection, Credentials } from "../storage/credentials.js";
import {
  acceptLoopbackDelivery,
  type Delivered,
  openRelayedDelivery,
  RelayedDeliveryError,
} from "./deliveries.js";
import { type LoopbackServer, startLoopbackServer } from "./loopback-server.js";

/** Why a connect didn't finish, each with a message for the terminal. */
export class ConnectError extends Error {
  override readonly name = "ConnectError";

  constructor(
    readonly reason:
      | "denied"
      | "expired"
      | "cancelled"
      | "collected"
      | "owner_changed"
      | "agent_key_mismatch"
      | "not_saved"
      | "no_terminal",
    message: string,
  ) {
    super(message);
  }
}

/** What the connect flow needs from the outside, injectable for tests. */
export interface ConnectDeps {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly cliVersion: string;
  readonly fetch: FetchLike;
  readonly credentials: Credentials;
  readonly trust: TrustState;
  /** Opens the connect page in the person's browser (or does nothing where there is none). */
  readonly openUrl: (url: string) => Promise<void>;
  readonly print: (line: string) => void;
  /** Whether a person can answer questions (a terminal on stdin). */
  readonly interactive: boolean;
  /** Asks a yes-or-no question in the terminal. */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly scheduler?: Scheduler;
  readonly now?: () => Date;
}

/** The longest wait between two polls after failures. */
const MAX_POLL_BACKOFF_SECONDS = 30;

type Outcome = { delivered: Delivered } | { error: unknown };

/**
 * `knowtarium connect`: makes an X25519 keypair, an Ed25519 keypair for direct writes and a
 * one-time secret, registers a connect request, listens on a random loopback port and opens
 * `<app>/connect?request=<id>#<fragment>` (the fragment, which no server sees, carries both
 * public keys, the port and the secret). It then
 * waits for the browser's delivery on the loopback port, polling the request meanwhile to notice
 * a denial, an expiry or a relayed delivery (when the browser can't reach the loopback, as over
 * SSH). A relayed delivery is accepted only after the person confirms the code matches the
 * browser's. The owner's signing key is pinned and the connection saved, encrypted, before the
 * browser hears `ok`; when either fails, the token is revoked and the browser told why.
 */
export async function runConnect(deps: ConnectDeps): Promise<Delivered> {
  const scheduler = deps.scheduler ?? systemScheduler;
  const now = deps.now ?? (() => new Date());
  const identity = {
    keyPair: createAgentKeyPair(),
    signing: createAgentSigningKeyPair(),
    secret: createConnectSecret(),
  };
  const api = createApiClient({
    baseUrl: deps.apiUrl,
    fetch: deps.fetch,
    auth: { kind: "session" },
  });
  const { data: started } = await api.call(routes.startConnect, {
    body: { cliVersion: deps.cliVersion },
  });

  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  // one delivery is taken (loopback or relay); the flow ends once it is saved or refused
  let claimed = false;
  let done = false;
  const finish = (value: Outcome) => {
    if (done) return;
    done = true;
    settle(value);
  };

  const server: LoopbackServer = await startLoopbackServer({
    appOrigin: new URL(deps.appUrl).origin,
    // the flow ends (and the server closes) only once the browser has its answer
    handle: async (body): Promise<{ answer: LoopbackResponse; after?: () => void }> => {
      if (claimed || done) return { answer: { ok: false, error: "already_connected" } };
      const result = acceptLoopbackDelivery(body, identity, { apiUrl: deps.apiUrl, now: now() });
      if (!result.ok) {
        const { revoke } = result;
        if (revoke === undefined) return { answer: result.answer };
        // an agent_key for another key: the token it came with is never used, so revoke it, and
        // the connect ends here (the browser treats this answer as final)
        claimed = true;
        const revoked = await revokeQuietly(deps, revoke);
        return {
          answer: result.answer,
          after: () => {
            finish({ error: keyMismatch(revoked) });
          },
        };
      }
      claimed = true;
      try {
        await complete(deps, result.delivered);
      } catch (error) {
        return {
          answer: {
            ok: false,
            error:
              error instanceof ConnectError && error.reason === "owner_changed"
                ? "owner_changed"
                : "save_failed",
          },
          after: () => {
            finish({ error });
          },
        };
      }
      return {
        answer: { ok: true },
        after: () => {
          finish({ delivered: result.delivered });
        },
      };
    },
  });

  try {
    const fragment = formatConnectFragment({
      publicKey: toBase64Url(identity.keyPair.publicKey),
      port: server.port,
      secret: toBase64Url(identity.secret),
      signPublicKey: toBase64Url(identity.signing.publicKey),
    });
    const url = `${deps.appUrl}${CONNECT_PAGE_PATH}?request=${started.requestId}#${fragment}`;
    deps.print("Opening the browser to connect this computer to Knowtarium.");
    deps.print(`If it doesn't open, visit:\n  ${url}`);
    await deps.openUrl(url).catch(() => undefined);

    void pollUntilDone({
      deps,
      identity,
      started,
      scheduler,
      now,
      isDone: () => done || claimed,
      claim: () => {
        if (claimed || done) return false;
        claimed = true;
        return true;
      },
      finish,
    });
    const result = await outcome;
    if ("error" in result) throw result.error;
    const { connection } = result.delivered;
    if (connection.access === "read-write" && connection.agentKey === undefined) {
      deps.print(
        "The web app didn't vouch for this computer's signing key, so your agents can only propose changes here. Once the web app is up to date, run `knowtarium connect` again to let them write directly where the workspace allows it.",
      );
    }
    return result.delivered;
  } finally {
    done = true;
    await server.close();
  }
}

/** The refusal of an `agent_key` that names another signing key or token than this CLI's. */
function keyMismatch(revoked: string): ConnectError {
  return new ConnectError(
    "agent_key_mismatch",
    `The workspace owner's approval vouched for a different signing key than this computer's, so nothing was saved${revoked}. The connect link may have been changed on its way to the browser: run \`knowtarium connect\` again, and tell the workspace owner if it happens again.`,
  );
}

/**
 * Pins the owner key and the agent policy floor from the owner's `agent_key` (no lower revision
 * is accepted from then on), and saves the connection. When either fails, the token just received
 * is revoked (nothing on this computer can use it) and a `ConnectError` says what happened. A
 * connection it replaces (connecting the same workspace again) has its token revoked, since
 * nothing on this computer uses it any more.
 */
async function complete(deps: ConnectDeps, delivered: Delivered): Promise<void> {
  const { connection } = delivered;
  try {
    await deps.trust.pinOwnerKey(connection.workspaceId, connection.ownerSignPublicKey);
    if (connection.agentKey !== undefined) {
      await deps.trust.acceptAgentPolicyRevision(
        connection.workspaceId,
        connection.agentKey.envelope.policyRevision,
      );
    }
  } catch (error) {
    const revoked = await revokeQuietly(deps, connection);
    if (isVaultError(error, "pin_mismatch")) {
      throw new ConnectError(
        "owner_changed",
        `This workspace's owner key differs from the one this computer pinned before, so nothing was saved${revoked}. If the owner really changed their keys, run \`npx knowtarium disconnect --workspace ${connection.workspaceId}\`, then connect again.`,
      );
    }
    throw new ConnectError(
      "not_saved",
      `The owner key couldn't be recorded (${describe(error)}), so nothing was saved${revoked}.`,
    );
  }
  let replaced;
  try {
    replaced = await deps.credentials.put(connection);
  } catch (error) {
    const revoked = await revokeQuietly(deps, connection);
    throw new ConnectError(
      "not_saved",
      `The connection couldn't be saved (${describe(error)})${revoked}. Fix that, then run \`knowtarium connect\` again.`,
    );
  }
  if (replaced !== undefined && replaced.tokenId !== connection.tokenId) {
    const revoked = await revokeQuietly(deps, replaced);
    deps.print(
      revoked === REVOKED
        ? `This computer's earlier connection to the workspace (token ${replaced.tokenId}) was revoked.`
        : `This computer no longer uses its earlier agent token for the workspace (${replaced.tokenId}): revoke it in the web app's settings.`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REVOKED = " and the new agent token was revoked";

/** Revokes a token; returns a phrase for the message saying whether it worked. */
async function revokeQuietly(
  deps: ConnectDeps,
  connection: Pick<Connection, "tokenId" | "tokenSecret"> & { readonly apiUrl?: string },
): Promise<string> {
  const api = createApiClient({
    baseUrl: connection.apiUrl ?? deps.apiUrl,
    fetch: deps.fetch,
    auth: { kind: "agent", token: connection.tokenSecret },
    timeoutMs: 15_000,
  });
  try {
    await api.call(routes.revokeToken, { params: { tokenId: connection.tokenId } });
    return REVOKED;
  } catch {
    return "; revoke the new agent token in the web app's settings";
  }
}

/** Whether a failed poll is worth retrying: the network, a server error or a rate limit. */
function isTransient(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (isSyncApiError(error) && (error.status >= 500 || error.code === "rate_limited"))
  );
}

/**
 * Polls the request until a delivery arrives some other way, or it ends. Failed polls are retried
 * with a growing wait (up to 30 seconds) until the request expires.
 */
async function pollUntilDone(options: {
  deps: ConnectDeps;
  identity: Parameters<typeof openRelayedDelivery>[1];
  started: {
    requestId: string;
    pollSecret: string;
    pollIntervalSeconds: number;
    expiresAt: string;
  };
  scheduler: Scheduler;
  now: () => Date;
  isDone: () => boolean;
  claim: () => boolean;
  finish: (value: Outcome) => void;
}): Promise<void> {
  const { deps, identity, started, scheduler, now, isDone, claim, finish } = options;
  const api = createApiClient({
    baseUrl: deps.apiUrl,
    fetch: deps.fetch,
    auth: { kind: "session" },
  });
  const expired = () =>
    new ConnectError("expired", "The connect request expired. Run `knowtarium connect` again.");
  let interval = started.pollIntervalSeconds;
  let backoff = interval;
  let failures = 0;
  const deadline = Date.parse(started.expiresAt);
  while (!isDone()) {
    await new Promise<void>((resolve) =>
      scheduler.setTimeout(resolve, (failures > 0 ? backoff : interval) * 1000),
    );
    if (isDone()) return;
    if (now().getTime() > deadline) {
      finish({ error: expired() });
      return;
    }
    let data;
    try {
      ({ data } = await api.call(routes.pollConnect, {
        params: { requestId: started.requestId },
        body: { pollSecret: started.pollSecret },
      }));
    } catch (error) {
      if (!isTransient(error)) {
        finish({ error });
        return;
      }
      failures++;
      backoff = Math.min(MAX_POLL_BACKOFF_SECONDS, interval * 2 ** failures);
      if (failures === 3) {
        deps.print("Can't reach Knowtarium right now; still waiting for the browser.");
      }
      continue;
    }
    failures = 0;
    switch (data.status) {
      case "pending":
      case "approved":
        interval = data.pollIntervalSeconds;
        continue;
      case "relayed": {
        if (isDone() || !claim()) return;
        finish(await relayed(deps, identity, data.encRelayPayload, now()));
        return;
      }
      case "denied":
        finish({
          error: new ConnectError("denied", "The connect request was refused in the browser."),
        });
        return;
      case "expired":
        finish({ error: expired() });
        return;
      case "completed":
        finish({
          error: new ConnectError(
            "collected",
            "This connect request was already completed elsewhere.",
          ),
        });
        return;
    }
  }
}

/**
 * A relayed delivery: opened and verified, then accepted only if the person confirms the code in
 * a terminal. Without a terminal, or when the codes differ, the token is revoked.
 */
async function relayed(
  deps: ConnectDeps,
  identity: Parameters<typeof openRelayedDelivery>[1],
  sealed: string,
  now: Date,
): Promise<Outcome> {
  let delivered: Delivered;
  try {
    delivered = await openRelayedDelivery(sealed, identity, {
      apiUrl: deps.apiUrl,
      fetch: deps.fetch,
      now,
    });
  } catch (error) {
    if (error instanceof RelayedDeliveryError) {
      const revoked = await revokeQuietly(deps, error.connection);
      if (error.reason === "mismatch") return { error: keyMismatch(revoked) };
      return {
        error: new ConnectError(
          "cancelled",
          `The connection the browser sent through Knowtarium couldn't be checked (${describe(error.cause)}), so nothing was saved${revoked}. Run \`knowtarium connect\` again.`,
        ),
      };
    }
    return {
      error: new ConnectError(
        "cancelled",
        `The key the browser sent through Knowtarium couldn't be opened or checked (${describe(error)}), so nothing was saved. Run \`knowtarium connect\` again.`,
      ),
    };
  }
  deps.print(
    "The browser couldn't reach this terminal directly, so it sent the key through Knowtarium.",
  );
  if (!deps.interactive) {
    const revoked = await revokeQuietly(deps, delivered.connection);
    return {
      error: new ConnectError(
        "no_terminal",
        `A key sent through Knowtarium needs its code confirmed in a terminal, and there is none here, so nothing was saved${revoked}. Run \`knowtarium connect\` in a terminal.`,
      ),
    };
  }
  deps.print(`Confirmation code: ${delivered.confirmationCode}`);
  if (!(await deps.confirm("Does the browser show this same code?"))) {
    const revoked = await revokeQuietly(deps, delivered.connection);
    return {
      error: new ConnectError(
        "cancelled",
        `The codes didn't match, so nothing was saved${revoked}.`,
      ),
    };
  }
  try {
    await complete(deps, delivered);
  } catch (error) {
    return { error };
  }
  return { delivered };
}
