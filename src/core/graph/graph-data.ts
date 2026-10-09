// The workspace's link graph as plain data for the graph view: one node per note (plus ghost
// nodes, optionally) with the fields the view colours by, one edge per linked pair. The shape is
// graphology's serialized format, so `Graph.from(data)` (or `graph.import(data)`) loads it as is.
import type { FreshnessOptions, FreshnessStatus } from "../freshness/freshness.js";
import type { LinkRef } from "../links/types.js";
import type { TrustTier } from "../trust/tier.js";
import { deriveVerification } from "../verification/derive.js";
import type { VerificationSignals, VerificationState } from "../verification/types.js";
import type { Note, NoteRole, Workspace } from "../workspace/types.js";

export interface GraphNodeAttributes {
  readonly label: string;
  /** The link target as written, for a ghost; `null` for a note. */
  readonly ghostTarget: string | null;
  /** `null` for a ghost (a link target with no note). */
  readonly path: string | null;
  readonly folder: string | null;
  readonly type: string | null;
  readonly role: NoteRole | null;
  readonly ghost: boolean;
  /** The OKF tier from the frontmatter, and the one from confirmed entries only (show this). */
  readonly tier: TrustTier | null;
  readonly confirmedTier: TrustTier | null;
  readonly state: VerificationState | null;
  readonly freshness: FreshnessStatus | null;
  readonly tags: readonly string[];
  /** Distinct notes this one links to, and distinct notes linking to it. */
  readonly linksOut: number;
  readonly linksIn: number;
}

export interface GraphEdgeAttributes {
  /** How many links from the source point at the target. */
  readonly count: number;
  readonly kinds: readonly LinkRef["kind"][];
  /** At least one of the links is an embed (`![[...]]`). */
  readonly embed: boolean;
}

export interface GraphNode {
  readonly key: string;
  readonly attributes: GraphNodeAttributes;
}

export interface GraphEdge {
  readonly key: string;
  readonly source: string;
  readonly target: string;
  readonly attributes: GraphEdgeAttributes;
}

export interface GraphData {
  readonly options: {
    readonly type: "directed";
    readonly multi: false;
    readonly allowSelfLoops: true;
  };
  readonly attributes: Readonly<Record<string, never>>;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface GraphDataOptions extends FreshnessOptions {
  /**
   * The verification signals of each note, required so that no caller trusts unsigned `human:`
   * entries by leaving them out: `{ humanEntries: { confirmed }, note, checks }` in the app, or
   * `{ humanEntries: "trust-frontmatter" }` for a plain OKF bundle.
   */
  readonly signals: (noteId: string) => VerificationSignals;
  /** Adds a node for each link target that has no note (default false). */
  readonly includeGhosts?: boolean;
}

/**
 * The key of the edge from one node to another: the source's length first, so no pair of keys
 * can produce the same text whatever characters the ids hold.
 */
export function graphEdgeKey(source: string, target: string): string {
  return `${String(source.length)}:${source}->${target}`;
}

/**
 * Ghost node keys: `ghost:` plus the normalized target, with more `ghost:` prefixes while a note
 * id already has that key. Find a ghost by its `ghostTarget` attribute rather than rebuilding it.
 */
function ghostKeys(notes: ReadonlyMap<string, unknown>): (target: string) => string {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  return (target) => {
    const normalized = target.trim().toLowerCase();
    const known = keys.get(normalized);
    if (known !== undefined) return known;
    let key = `ghost:${normalized}`;
    while (notes.has(key) || used.has(key)) key = `ghost:${key}`;
    keys.set(normalized, key);
    used.add(key);
    return key;
  };
}

interface EdgeDraft {
  count: number;
  kinds: Set<LinkRef["kind"]>;
  embed: boolean;
}

function noteNode(note: Note, options: GraphDataOptions): GraphNodeAttributes {
  const verification = deriveVerification(note.frontmatter, {
    ...options.signals(note.id),
    now: options.now,
    ...(options.windows === undefined ? {} : { windows: options.windows }),
  });
  return {
    label: note.title,
    ghostTarget: null,
    path: note.path,
    folder: note.folder,
    type: note.fields.type ?? null,
    role: note.role,
    ghost: false,
    tier: verification.tier.tier,
    confirmedTier: verification.confirmedTier.tier,
    state: verification.state,
    freshness: verification.freshness.status,
    tags: note.fields.tags ?? [],
    linksOut: 0,
    linksIn: 0,
  };
}

/** Builds the graph data of a workspace, with each note's tier, state and freshness. */
export function buildGraphData(workspace: Workspace, options: GraphDataOptions): GraphData {
  const notes = [...workspace.notes.values()].sort((a, b) => a.path.localeCompare(b.path));
  const nodes = new Map<string, GraphNodeAttributes>();
  for (const note of notes) nodes.set(note.id, noteNode(note, options));

  const edges = new Map<string, Map<string, EdgeDraft>>();
  const ghosts = new Map<string, string>();
  const ghostKey = ghostKeys(workspace.notes);
  for (const note of notes) {
    const out = new Map<string, EdgeDraft>();
    for (const link of workspace.links.get(note.id) ?? []) {
      let target: string;
      if (link.resolution.status === "note") target = link.resolution.noteId;
      else if (link.resolution.status === "ghost" && options.includeGhosts === true) {
        target = ghostKey(link.target);
        if (!ghosts.has(target)) ghosts.set(target, link.target.trim());
      } else continue;
      const edge = out.get(target) ?? { count: 0, kinds: new Set(), embed: false };
      edge.count++;
      edge.kinds.add(link.kind);
      edge.embed ||= link.embed;
      out.set(target, edge);
    }
    if (out.size > 0) edges.set(note.id, out);
  }
  for (const [key, label] of [...ghosts].sort((a, b) => a[0].localeCompare(b[0]))) {
    nodes.set(key, {
      label,
      ghostTarget: label,
      path: null,
      folder: null,
      type: null,
      role: null,
      ghost: true,
      tier: null,
      confirmedTier: null,
      state: null,
      freshness: null,
      tags: [],
      linksOut: 0,
      linksIn: 0,
    });
  }

  const linksIn = new Map<string, number>();
  const edgeList: GraphEdge[] = [];
  for (const [source, out] of edges) {
    for (const [target, edge] of out) {
      linksIn.set(target, (linksIn.get(target) ?? 0) + 1);
      edgeList.push({
        key: graphEdgeKey(source, target),
        source,
        target,
        attributes: { count: edge.count, kinds: [...edge.kinds].sort(), embed: edge.embed },
      });
    }
  }
  const nodeList = [...nodes].map(([key, attributes]) => ({
    key,
    attributes: {
      ...attributes,
      linksOut: edges.get(key)?.size ?? 0,
      linksIn: linksIn.get(key) ?? 0,
    },
  }));
  return {
    options: { type: "directed", multi: false, allowSelfLoops: true },
    attributes: {},
    nodes: nodeList,
    edges: edgeList,
  };
}
