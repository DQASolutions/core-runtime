// Instance Graph context (Layer 2) — the default traversal planner (ADR-0007).
// When the StorageAdapter provides a native traverse() it is used; otherwise we
// walk the relationship `path` step-by-step over queryEdges. backward + a
// reversed path is exactly `truy_nguoc` (source-spec §3.4).
//
// FR-N08: nodes[0] is always the start instance.
// @impl S006-AC-007, S006-AC-011
// FR-D01: edges.length === nodes.length - 1 for a clean linear path.
// FR-N09: traversal terminates gracefully when no edges exist at a step.
// FR-X01: empty path → nodes=[startInstance], edges=[].
// FR-X05: backward + directed:false → follows edges at both endpoints.
//
// DoS guards (SEC-OTHER-05/06/07):
const MAX_PATH_DEPTH = 20   // max relationship hops per traversal
const MAX_NODES = 1_000     // max distinct nodes accumulated across all frontier paths

import {
  type Edge,
  type Instance,
  type TraversalResult,
  type TraversalStep,
  type TraverseSpec,
  ontologyError,
} from '../../types/index.js'
import type { StorageAdapter } from '../../ports/storage-adapter.js'
import { matchesProperties } from '../../shared/condition-match.js'
// @impl S006-AC-001, S006-AC-002, S006-AC-005, S006-AC-006, S006-AC-010

// @impl S006-AC-001, S006-AC-002, S006-AC-005, S006-AC-006, S006-AC-010
export async function planTraversal(
  spec: TraverseSpec,
  adapter: StorageAdapter,
): Promise<TraversalResult> {
  if (adapter.traverse) return adapter.traverse(spec)

  // FR-E02: start must exist
  const start = await adapter.getInstance(spec.start)
  if (!start) {
    throw ontologyError('INSTANCE_NOT_FOUND', `Traversal start instance "${spec.start}" not found`)
  }

  // SEC-OTHER-05: reject paths that exceed the depth limit
  if (spec.path.length > MAX_PATH_DEPTH) {
    throw ontologyError(
      'TRAVERSAL_LIMIT_EXCEEDED',
      `traverse() path length ${spec.path.length} exceeds the maximum of ${MAX_PATH_DEPTH} hops`,
    )
  }

  // FR-X01 / FR-N08: empty path → return start node only
  if (spec.path.length === 0) {
    return {
      start: spec.start,
      path: spec.path,
      direction: spec.direction,
      paths: [[]],
      nodes: [start],
      edges: [],
    }
  }

  // Frontier carries, per active path, the current node and the steps so far.
  // Each entry's steps accumulates (edge, node) pairs where `node` is the
  // *neighbor* reached via that edge (i.e. the *next* node, not the current).
  let frontier: { node: Instance; steps: TraversalStep[] }[] = [{ node: start, steps: [] }]

  // SEC-OTHER-06: track every node ID added to the frontier to prevent cyclic expansion.
  // A node already in the frontier from a prior step is skipped — this breaks A→B→A loops.
  // SEC-OTHER-07: count total nodes accumulated; abort if MAX_NODES is exceeded.
  const visitedIds = new Set<string>([start.id])

  for (const relationship of spec.path) {
    const next: { node: Instance; steps: TraversalStep[] }[] = []
    for (const { node, steps } of frontier) {
      let edges: Edge[]
      if (spec.direction === 'forward') {
        edges = await adapter.queryEdges({ relationship, fromId: node.id })
      } else {
        // FR-N04 backward: follow edges where toId equals current node
        edges = await adapter.queryEdges({ relationship, toId: node.id })
        // FR-X05: for undirected relationships, also follow the other direction
        // The relationship type's directed flag is not available in Layer 2, but
        // we can check if there are also "from" edges (which would indicate the
        // edge was stored with this node as fromId). We query both directions and
        // deduplicate by edge id.
        const forwardEdges = await adapter.queryEdges({ relationship, fromId: node.id })
        const seen = new Set(edges.map((e) => e.id))
        for (const fe of forwardEdges) {
          if (!seen.has(fe.id)) edges.push(fe)
        }
      }
      for (const edge of edges) {
        // For forward: neighbor is toId; for backward: neighbor is fromId
        // For backward with undirected (FR-X05): if this node is "from", neighbor is "to"
        let neighborId: string
        if (spec.direction === 'forward') {
          neighborId = edge.toId
        } else {
          // When going backward: we want the "other" end from the current node
          neighborId = edge.fromId === node.id ? edge.toId : edge.fromId
        }
        // SEC-OTHER-06: skip already-visited nodes to break cycles
        if (visitedIds.has(neighborId)) continue
        const neighbor = await adapter.getInstance(neighborId)
        if (!neighbor) continue
        if (spec.where && !matchesProperties(spec.where, neighbor.data)) continue
        // SEC-OTHER-07: enforce node count limit before expanding further
        if (visitedIds.size >= MAX_NODES) {
          throw ontologyError(
            'TRAVERSAL_LIMIT_EXCEEDED',
            `traverse() exceeded the maximum of ${MAX_NODES} nodes`,
          )
        }
        visitedIds.add(neighborId)
        next.push({ node: neighbor, steps: [...steps, { edge, node: neighbor }] })
      }
    }
    // FR-N09: if no edges found at this step, traversal terminates; return what was collected
    if (next.length === 0) break
    frontier = next
  }

  // Build the result: paths, nodes (start-first, de-duplicated), edges (ordered)
  const paths = frontier.map((f) => f.steps)

  // For a linear single-path result (the common case), build ordered nodes and edges.
  // FR-N08: nodes[0] is always the start instance.
  // FR-D01: for a linear path, edges.length = nodes.length - 1.
  // We use the first completed path (frontier[0]) for the linear representation.
  const resultNodes: Instance[] = []
  const resultEdges: Edge[] = []

  if (frontier.length > 0) {
    // Add start node first
    resultNodes.push(start)
    // Then add all nodes from the first frontier path in order
    const firstPath = frontier[0]!.steps
    for (const step of firstPath) {
      resultEdges.push(step.edge)
      resultNodes.push(step.node)
    }
  } else {
    // No frontier reached — return only the start node (FR-N09 / FR-X02)
    resultNodes.push(start)
  }

  // Build de-duplicated flat nodes/edges across all paths (for multi-branch traversals)
  // For linear paths this is identical to the above.
  const seenIds = new Set<string>()
  const flatNodes: Instance[] = []
  const flatEdges: Edge[] = []

  // Always start with the start node
  seenIds.add(start.id)
  flatNodes.push(start)

  // Build flat ordered lists from the first path (dominant path for linear traversal)
  for (const step of (frontier[0]?.steps ?? [])) {
    flatEdges.push(step.edge)
    if (!seenIds.has(step.node.id)) {
      seenIds.add(step.node.id)
      flatNodes.push(step.node)
    }
  }

  return {
    start: spec.start,
    path: spec.path,
    direction: spec.direction,
    paths,
    nodes: flatNodes,
    edges: flatEdges,
  }
}
