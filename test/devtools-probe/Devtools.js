/**
 * @zakkster/lite-devtools -- reactive-graph inspection for @zakkster/lite-signal. v1.1.0
 * -----------------------------------------------------------------------------
 * Built entirely on lite-signal's public introspection surface (no private symbols,
 * no patched objects). Requires lite-signal >= 1.1.5: the source eagerly imports
 * `describe` and `nodeId` (added in 1.1.5), so Node's ESM linker would throw a
 * SyntaxError at module load on an older lite-signal. The helpers split into two
 * conceptual families:
 *
 *   - Identity-needing -- inspect / report / track / graph / toTree
 *       -- describe + nodeId give every yielded node a stable id, which is what makes
 *         neighbourhood snapshots persistent and the BFS dedupe by id (so diamonds
 *         and convergence in the DAG resolve to one node, not many).
 *   - Enumeration-only -- subscribers / dependencies / monitor / leakWatch / toDot
 *       -- could in principle target the 1.1.4 introspection floor in isolation, but
 *         ship in the same module, so the 1.1.5 floor applies to all.
 *
 * Non-perturbing by design: values are read with peek() (untracked) and the graph is
 * walked with the enumerators, so inspecting NEVER adds an observer. The only thing that
 * touches the graph is track(), which registers a lifecycle listener (no edges).
 * Everything here is a cold/debug path -- it allocates freely; nothing runs in a hot loop.
 *
 * Type definitions ship in Devtools.d.ts; every public function carries a JSDoc summary
 * here, the formal contract is in the .d.ts.
 *
 * MIT (c) Zahary Shinikchiev
 */
import {
    stats, hasObservers, observeObservers, forEachObserver, forEachSource, nodeId, describe,
} from "../../Signal.js";
import * as SIG from "../../Signal.js";

// Optional engine APIs, feature-detected so this module keeps loading on the
// 1.1.5 floor. Named imports above are the hard floor (ESM link error below it);
// everything newer degrades gracefully:
//   forEachOwned / ownerOf    -- lite-signal 1.3 owner-tree introspection
//   onGraphMutation           -- lite-signal 1.2.1 graph-mutation hook (the keystone)
const HAS_OWNERS = typeof SIG.forEachOwned === "function" && typeof SIG.ownerOf === "function";
const HAS_HOOK = typeof SIG.onGraphMutation === "function";

/** Engine capability snapshot -- lets a consumer (lite-studio) pick push vs poll
 *  and show/hide the ownership view without try/catch probing. */
export function capabilities() {
    return {floor: "1.1.5", owners: HAS_OWNERS, mutationHook: HAS_HOOK};
}

// One engine listener, many internal consumers (watchGraph / profile). The
// engine hook is single-listener by design (zero-cost null check); devtools
// multiplexes behind it and unregisters when the last consumer stops, returning
// the engine to its zero-cost state.
const hubSubs = new Set();
let hubOff = null;
function hubDispatch(op, a, b) {
    // The engine fires this SYNCHRONOUSLY from inside mutation points
    // (createNode / disposeNode / link wiring / recompute). A subscriber that
    // throws here would unwind through engine internals mid-operation -- the
    // hook contract is "observe, never throw, never mutate", and devtools
    // enforces the never-throw half for every consumer it multiplexes.
    // (Verified by probe: an uncaught onSample throw escaped through
    // executeEffect before this guard existed.)
    for (const fn of hubSubs) {
        try { fn(op, a, b); }
        catch (e) {
            // Cold path, debug tooling: surface, never propagate.
            try { console.error("[lite-devtools] graph-mutation subscriber threw:", e); } catch (_) { /* no console */ }
        }
    }
}
function hubAdd(fn) {
    hubSubs.add(fn);
    if (hubOff === null && HAS_HOOK) hubOff = SIG.onGraphMutation(hubDispatch);
    return () => {
        hubSubs.delete(fn);
        if (hubSubs.size === 0 && hubOff !== null) { hubOff(); hubOff = null; }
    };
}
import {every} from "@zakkster/lite-time";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function peekSafe(handle) {
    try {
        return typeof handle?.peek === "function" ? handle.peek() : undefined;
    } catch (e) {
        return undefined;
    }
}

// --- Single-node inspection ---------------------------------------------------

/**
 * A non-perturbing snapshot of a handle and its immediate neighbourhood.
 * Walks the source-list and observer-list once; reads value via peek() so no
 * dependency edge is recorded.
 *
 * @param {object} handle  A signal / computed / effect-handle from @zakkster/lite-signal.
 * @returns {{id:number|undefined, kind:"signal"|"computed"|"effect"|undefined,
 *           observed:boolean, value:unknown, observerCount:number, sourceCount:number,
 *           observers:Array<{id:number,kind:string,value:unknown}>,
 *           sources:Array<{id:number,kind:string,value:unknown}>}}
 *          Snapshot. `id`/`kind` are `undefined` on a non-handle (rest of the
 *          shape is still well-formed: empty arrays, zero counts).
 */
export function inspect(handle) {
    const d = describe(handle);
    const observers = [], sources = [];

    forEachObserver(handle, (o) => observers.push(o));
    forEachSource(handle, (s) => sources.push(s));

    // Stale = it walks and quacks like a handle but the engine refuses to
    // resolve it: under lite-signal >= 1.2.1 introspection is gen-guarded, so a
    // handle whose slot was recycled (owner-cascade re-run, explicit dispose)
    // describes as undefined. Report that as a first-class state instead of an
    // empty shell -- "this WAS a node and is gone" beats "never heard of it".
    const looksLikeHandle = handle != null && (typeof handle === "function" || typeof handle.peek === "function" || typeof handle.id === "number");
    const stale = d === undefined && looksLikeHandle;

    return {
        id: d ? d.id : undefined,
        kind: d ? d.kind : undefined,
        stale,
        observed: hasObservers(handle),
        value: peekSafe(handle),
        observerCount: observers.length,
        sourceCount: sources.length,
        observers,                       // [{ id, kind, value }]
        sources,                         // [{ id, kind, value }]
    };
}

/**
 * Things observing `handle` -- the computeds/effects that read it.
 *
 * @param {object} handle  A signal / computed / effect-handle.
 * @returns {Array<{id:number,kind:string,value:unknown}>}  Live snapshot; iteration order
 *          matches insertion (subscribe order). No-op on a non-handle (returns []).
 */
export function subscribers(handle) {
    const a = [];

    forEachObserver(handle, (d) => a.push(d));

    return a;
}

/**
 * Things `handle` reads -- its current dependency set.
 *
 * @param {object} handle  A computed / effect-handle (signals have no dependencies, returns []).
 * @returns {Array<{id:number,kind:string,value:unknown}>}  Live snapshot in dependency
 *          order (the order the body read them). No-op on a non-handle (returns []).
 */
export function dependencies(handle) {
    const a = [];

    forEachSource(handle, (d) => a.push(d));

    return a;
}

// --- Live lifecycle feed ------------------------------------------------------

/**
 * Live "is anyone watching this" feed. Fires on 0->1 (connect) and 1->0 (disconnect)
 * observer transitions -- the same hook lite-time/lite-raf use for auto-pause, here
 * repurposed to log lifecycle.
 *
 * @param {object} handle  A signal / computed.
 * @param {(ev:{type:"connect"|"disconnect", id:number, observed:boolean, ts:number}) => void} onEvent
 *        Fires after each transition. Stable id, monotonic ts (performance.now()).
 * @returns {() => void}  Idempotent unsubscribe. After calling, no further events fire.
 */
export function track(handle, onEvent) {
    const id = nodeId(handle);          // stable for the handle's lifetime -> computed once at registration

    const offLifecycle = observeObservers(handle, {
        onConnect: () => onEvent({type: "connect", id, observed: true, ts: now()}),
        onDisconnect: () => onEvent({type: "disconnect", id, observed: false, ts: now()}),
    });

    // Death notice (1.1): under lite-signal >= 1.2 the engine disposes owned
    // nodes autonomously on an owner re-run -- the lifecycle pair above never
    // fires for that. With the 1.2.1 graph-mutation hook we can deliver the
    // missing event; without it, track keeps its 1.0 semantics (documented).
    let offHook = null;
    if (HAS_HOOK && id !== undefined) {
        offHook = hubAdd((op, a) => {
            if (op === 2 && a === id) onEvent({type: "dispose", id, observed: false, ts: now()});
        });
    }
    return () => { if (offHook !== null) offHook(); return offLifecycle(); };
}

/**
 * Current engine stats (signals / computeds / effects / activeLinks / activeNodes / pool).
 * Pass-through to lite-signal's stats(); kept here so importers don't pull two paths.
 *
 * @returns {object}  The lite-signal RegistryStats -- see the Signal.d.ts of lite-signal for the
 *                    full shape (signals, computeds, effects, activeLinks, pooledLinks,
 *                    linkPoolCapacity, plus the optional activeNodes / nodePoolCapacity).
 */
export function monitor() {
    return stats();
}

/**
 * Sample activeNodes over time and flag suspicious growth -- a cheap leak detector for a
 * mount/unmount-heavy app (catches scopes that forgot to dispose).
 *
 * Cadence via lite-time's drift-corrected, boundary-aligned scheduler rather than a raw
 * setInterval: one wall-clock authority for the toolkit, honours any `sampleMs`, self-unrefs,
 * and -- unlike watch(now) -- stays OUT of the reactive graph it measures. A leak detector
 * must not instrument itself into the graph.
 *
 * Internal sample buffer is capped at 128 entries (oldest evicted FIFO).
 *
 * @param {{sampleMs?:number, growth?:number,
 *          onSample?:(sample:{ts:number, activeNodes:number, delta:number, leakSuspected:boolean}) => void}} [opts]
 *        sampleMs: poll interval (default 1000). growth: per-sample activeNodes delta that
 *        flips `leakSuspected` true (default 32). onSample: per-tick callback.
 * @returns {{stop:() => void, samples:Array<{ts:number, activeNodes:number, delta:number, leakSuspected:boolean}>}}
 *          stop: cancel polling. samples: rolling window of the last 128 ticks (shared by reference).
 */
export function leakWatch({sampleMs = 1000, growth = 32, onSample} = {}) {
    // activeNodes is an optional stats field; fall back to the kind counters so
    // delta never goes NaN-silent on engines (or registries) that omit it.
    const liveCount = (s) => (s.activeNodes !== undefined ? s.activeNodes : (s.signals | 0) + (s.computeds | 0) + (s.effects | 0));
    let prev = liveCount(stats());
    const samples = [];
    const stop = every(sampleMs, () => {
        const s = stats();
        const live = liveCount(s);
        const delta = live - prev;
        prev = live;
        const rec = {ts: now(), activeNodes: live, delta, leakSuspected: delta >= growth};
        samples.push(rec);
        if (samples.length > 128) samples.shift();
        if (onSample) onSample(rec);
    });
    return {stop, samples};
}

/**
 * Combined snapshot: engine stats + the neighbourhood of each registered handle.
 * Useful as the body of a debug overlay's redraw, or the payload of an error report.
 *
 * @param {Array<object>} handles  Handles to inspect.
 * @returns {{stats:object, nodes:Array<ReturnType<typeof inspect>>}}
 *          stats: monitor() snapshot. nodes: per-handle inspect() result, same order as input.
 */
export function report(handles) {
    return {stats: stats(), nodes: handles.map((h) => inspect(h))};
}

// --- Full auto-discovered DAG (1.1.5+) ----------------------------------------

/**
 * Breadth-first walk of the entire reactive graph reachable from `roots`, in both
 * directions (observers + sources). Returns { nodes, edges } with nodes deduped by
 * stable id and edges deduped + directed source->observer. Diamonds and convergence are
 * handled by the id-keyed visited set; `maxNodes` caps a runaway walk.
 *
 *   const { nodes, edges } = graph([rootSignal, anotherRoot]);
 *   // nodes: [{ id, kind, value }]   edges: [{ from, to }]  (from depends-upon -> to)
 *
 * @param {object | Array<object>} roots  One handle or an array of handles to start from.
 * @param {{maxNodes?:number}} [opts]  Hard cap on discovered nodes (default 10000). Walk stops
 *        when the cap is reached; the partial graph returned is still consistent.
 * @returns {{nodes:Array<{id:number,kind:string,value:unknown}>, edges:Array<{from:number,to:number}>}}
 *          Nodes deduped by id; edges deduped and directed source -> observer.
 */
export function graph(roots, {maxNodes = 10000, owners = false} = {}) {
    const rootList = Array.isArray(roots) ? roots : [roots];
    const nodes = new Map();              // id -> { id, kind, value }
    const edges = [];                     // { from, to }
    const edgeSeen = new Set();
    const visited = new Set();            // ids whose neighbourhood has been expanded
    const queue = [];

    const note = (d) => {
        // Store the engine-supplied descriptor as-is. It carries the node
        // reference (and, on lite-signal >= 1.2.1, the generation stamp) via
        // symbol-keyed plain properties, so the visible shape stays
        // {id, kind, value} (clean for JSON / DOT / logs) but the descriptor
        // remains re-walkable through inspect / subscribers / dependencies.
        // Copying into a plain object literal would strip the hidden symbols
        // and make every yielded node un-inspectable.
        // Cap enforced HERE, not just per-dequeue: one node with 100k observers
        // must not blow maxNodes inside a single expansion.
        if (nodes.size >= maxNodes) return false;
        if (!nodes.has(d.id)) nodes.set(d.id, d);
        return true;
    };

    const link = (from, to, kind) => {
        const k = from + ">" + to + (kind !== undefined ? ":" + kind : "");
        if (!edgeSeen.has(k)) {
            edgeSeen.add(k);
            edges.push(kind !== undefined ? {from, to, kind} : {from, to});
        }
    };
    const withOwners = owners === true && HAS_OWNERS;

    for (const h of rootList) {
        const d = describe(h);
        if (d) {
            note(d);
            queue.push(d);
        }
    }

    // Cursor walk: O(1) dequeue with true FIFO ordering (real BFS). queue.shift() would be
    // O(N) per step -> O(N^2) on large graphs; advancing an integer head never reindexes.
    let qHead = 0;

    while (qHead < queue.length) {
        if (nodes.size > maxNodes) break;

        const h = queue[qHead++];
        const id = nodeId(h);

        if (id === undefined || visited.has(id)) continue;

        visited.add(id);
        // descriptors are re-walkable (they carry the node), so we recurse on them directly.
        // Link guard: only emit an edge if the neighbour was actually accepted (already
        // known, or admitted by note() under the cap). Otherwise we would output edges
        // whose endpoints are missing from `nodes`, breaking the result-consistency
        // invariant assertion: "every edge endpoint must be in nodes".
        forEachObserver(h, (d) => {
            const accepted = nodes.has(d.id) || note(d);
            if (!accepted) return;
            link(id, d.id);
            queue.push(d);
        });

        forEachSource(h, (d) => {
            const accepted = nodes.has(d.id) || note(d);
            if (!accepted) return;
            link(d.id, id);
            queue.push(d);
        });

        // Ownership edges (1.1, lite-signal >= 1.3): owned children join the
        // frontier even when they share no data edge with it -- nested
        // effects/computeds with disjoint dependencies were invisible to the
        // 1.0 walk. Edge kind "owner" keeps them distinguishable from dep
        // edges in diff() keys and DOT styling.
        if (withOwners) {
            SIG.forEachOwned(h, (d) => {
                const accepted = nodes.has(d.id) || note(d);
                if (!accepted) return;
                link(id, d.id, "owner");
                queue.push(d);
            });
        }
    }
    return {nodes: [...nodes.values()], edges};
}

/**
 * Render a graph() result as Graphviz DOT -- paste into any DOT viewer.
 * Signals are ellipses, computeds boxes, effects diamonds.
 *
 * @param {{nodes:Array<{id:number,kind:string,value:unknown}>, edges:Array<{from:number,to:number}>}} g
 *        Output of graph().
 * @param {{name?:string, maxLabel?:number}} [opts]  name: digraph identifier (default "reactive").
 *        maxLabel: truncate value strings in labels to this many chars (default 24).
 * @returns {string}  DOT source.
 */
export function toDot(g, {name = "reactive", maxLabel = 24} = {}) {
    const shape = (k) => (k === "signal" ? "ellipse" : k === "computed" ? "box" : k === "effect" ? "diamond" : "plaintext");
    const esc = (v) => String(v).replace(/["\\\n]/g, " ").slice(0, maxLabel);
    const lines = [`digraph ${name} {`, "  rankdir=LR;", '  node [fontname="monospace"];'];

    for (const n of g.nodes) lines.push(`  n${n.id} [label="${n.kind}#${n.id}\\n${esc(n.value)}", shape=${shape(n.kind)}];`);
    for (const e of g.edges) lines.push(e.kind === "owner" ? `  n${e.from} -> n${e.to} [style=dashed, color=gray, arrowhead=odot];` : `  n${e.from} -> n${e.to};`);

    lines.push("}");
    return lines.join("\n");
}

/**
 * Console-friendly indented tree from a single root. direction "down" follows observers
 * (who depends on this), "up" follows sources (what this depends on). Already-visited
 * nodes are marked with a a `(seen)` marker rather than expanded (the graph is a DAG, not a tree).
 *
 * @param {object} root  A signal / computed / effect-handle.
 * @param {{direction?:"down"|"up", maxDepth?:number}} [opts]  direction: "down" walks observers
 *        (subscribers), "up" walks sources (dependencies). Default "down". maxDepth: depth cap
 *        (default Infinity).
 * @returns {string}  Indented text. Empty string on a non-handle.
 */
export function toTree(root, {direction = "down", maxDepth = Infinity} = {}) {
    const walk = direction === "up" ? forEachSource : forEachObserver;
    const out = [];
    const seen = new Set();

    const rec = (h, depth) => {
        const d = describe(h);
        if (!d) return;
        const pad = "  ".repeat(depth);
        const tag = `${d.kind}#${d.id} = ${String(d.value).slice(0, 24)}`;
        if (seen.has(d.id)) {
            out.push(pad + "(seen) " + tag);
            return;
        }   // recycle glyph = already-visited (DAG re-converge)
        seen.add(d.id);
        out.push(pad + tag);
        if (depth >= maxDepth) return;
        walk(h, (c) => rec(c, depth + 1));   // walkers grab nextSub/nextDep before fn -> re-entrant-safe
    };
    rec(root, 0);
    return out.join("\n");
}

// --- Structural diff + trace (1.1) --------------------------------------------

/**
 * Diff two graph() snapshots. Nodes are matched by stable id, edges by direction
 * (from>to). Under lite-signal 1.2's owner tree, re-running or disposing an owner
 * cascade-disposes its owned observers -- those surface here as removedNodes, which
 * makes the otherwise-internal ownership behaviour observable: snapshot, act,
 * snapshot, diff. Pure and non-perturbing (operates on already-captured snapshots).
 *
 * @param {{nodes:Array<{id:number,kind:string,value:unknown}>, edges:Array<{from:number,to:number}>}} before
 * @param {{nodes:Array<{id:number,kind:string,value:unknown}>, edges:Array<{from:number,to:number}>}} after
 * @returns {{addedNodes:Array<object>, removedNodes:Array<object>,
 *           changedNodes:Array<{id:number,kind:string,from:unknown,to:unknown}>,
 *           addedEdges:Array<{from:number,to:number}>, removedEdges:Array<{from:number,to:number}>}}
 *          addedNodes/removedNodes deduped by id; changedNodes are same-id value changes
 *          (Object.is); addedEdges/removedEdges deduped by direction.
 */
export function diff(before, after) {
    const beforeNodes = new Map();
    for (const n of before.nodes) beforeNodes.set(n.id, n);
    const afterNodes = new Map();
    for (const n of after.nodes) afterNodes.set(n.id, n);

    const addedNodes = [], changedNodes = [];
    for (const n of after.nodes) {
        const b = beforeNodes.get(n.id);
        if (b === undefined) addedNodes.push(n);
        else if (!Object.is(b.value, n.value)) changedNodes.push({id: n.id, kind: n.kind, from: b.value, to: n.value});
    }
    const removedNodes = [];
    for (const n of before.nodes) if (!afterNodes.has(n.id)) removedNodes.push(n);

    const ek = (e) => e.from + ">" + e.to + (e.kind !== undefined ? ":" + e.kind : "");
    const beforeEdges = new Set();
    for (const e of before.edges) beforeEdges.add(ek(e));
    const afterEdges = new Set();
    for (const e of after.edges) afterEdges.add(ek(e));

    const addedEdges = [], removedEdges = [];
    for (const e of after.edges) if (!beforeEdges.has(ek(e))) addedEdges.push(e);
    for (const e of before.edges) if (!afterEdges.has(ek(e))) removedEdges.push(e);

    return {addedNodes, removedNodes, changedNodes, addedEdges, removedEdges};
}

/**
 * Capture the graph before and after running `fn`, and diff them -- the one-liner
 * for "what did this action do to the graph", including owner-cascade removals under
 * lite-signal 1.2. `fn` runs synchronously between the two snapshots.
 *
 * @param {object|Array<object>} roots  Handle(s) to walk from (same as graph()).
 * @param {() => void} fn  Action to run between snapshots.
 * @param {{maxNodes?:number}} [opts]  Forwarded to graph().
 * @returns {{before:object, after:object, diff:object}}  The two snapshots and their diff.
 */
export function trace(roots, fn, opts) {
    const before = graph(roots, opts);
    try {
        fn();
    } catch (e) {
        // The action blew up -- that is exactly when "what did it do to the
        // graph first" matters. Attach the partial trace and rethrow.
        const after = graph(roots, opts);
        try { e.graphTrace = {before, after, diff: diff(before, after)}; } catch (_) { /* frozen/sealed error */ }
        throw e;
    }
    const after = graph(roots, opts);
    return {before, after, diff: diff(before, after)};
}


// --- Owner-tree walk (1.1, lite-signal >= 1.3) ---------------------------------

/**
 * Nested ownership hierarchy from a root handle: which nodes this one owns
 * (created inside its body) and would cascade-dispose on its next re-run. The
 * dependency DAG answers "who updates whom"; this answers "who outlives whom".
 *
 * @param {object} root  A handle or re-walkable descriptor.
 * @param {{maxDepth?:number, maxNodes?:number}} [opts]
 * @returns {{id:number, kind:string, value:unknown, owned:Array<object>}|null}
 *          Nested tree, or null when the engine has no owner introspection
 *          (lite-signal < 1.3 -- check capabilities().owners).
 */
export function ownerTree(root, {maxDepth = Infinity, maxNodes = 10000} = {}) {
    if (!HAS_OWNERS) return null;
    const d = describe(root);
    if (d === undefined) return null;
    let count = 0;
    const seen = new Set();              // defensive: the owner relation is a tree, but never trust a graph
    const build = (desc, depth) => {
        if (seen.has(desc.id)) return {id: desc.id, kind: desc.kind, value: desc.value, owned: []};
        seen.add(desc.id);
        count++;
        const node = {id: desc.id, kind: desc.kind, value: desc.value, owned: []};
        if (depth < maxDepth && count < maxNodes) {
            SIG.forEachOwned(desc, (c) => { if (count < maxNodes) node.owned.push(build(c, depth + 1)); });
        }
        return node;
    };
    return build(d, 0);
}

// --- Path finding (1.1): "why did X update" ------------------------------------

/**
 * Shortest dependency path between two handles, BFS over observer edges
 * (`direction: "down"`, default: from -> ... -> to follows data flow) or source
 * edges (`"up"`). The classic question it answers: a write to `from` re-ran
 * effect `to` -- through which computeds?
 *
 * @param {object} from  Handle / descriptor at the path start.
 * @param {object} to    Handle / descriptor at the path end.
 * @param {{direction?:"down"|"up", maxNodes?:number}} [opts]
 * @returns {Array<{id:number,kind:string,value:unknown}>|null}
 *          Descriptor path INCLUSIVE of both ends, or null (no path / stale ends).
 */
export function findPath(from, to, {direction = "down", maxNodes = 100000} = {}) {
    const start = describe(from), goal = describe(to);
    if (start === undefined || goal === undefined) return null;
    if (start.id === goal.id) return [start];
    const walk = direction === "up" ? forEachSource : forEachObserver;
    const parent = new Map();            // id -> parent descriptor
    const byId = new Map([[start.id, start]]);
    const queue = [start];
    let qHead = 0;
    while (qHead < queue.length && byId.size <= maxNodes) {
        const h = queue[qHead++];
        let found = false;
        walk(h, (d) => {
            if (found || byId.has(d.id)) return;
            byId.set(d.id, d);
            parent.set(d.id, h);
            if (d.id === goal.id) { found = true; return; }
            queue.push(d);
        });
        if (found) {
            const path = [byId.get(goal.id)];
            let cur = goal.id;
            while (cur !== start.id) { const p = parent.get(cur); path.push(p); cur = p.id; }
            return path.reverse();
        }
    }
    return null;
}

// --- Push-based graph watching (1.1, lite-signal >= 1.2.1 hook) ----------------

/**
 * Event-driven graph observation: the callback fires (microtask-coalesced) only
 * when the watched neighbourhood actually changed, with a fresh snapshot and a
 * structural diff against the previous one. Falls back to polling on engines
 * without the graph-mutation hook, so consumers (lite-studio) write one code path.
 *
 * @param {object|Array<object>} roots  Same as graph().
 * @param {(payload:{graph:object, diff:object|null, mutations:number, mode:"push"|"poll"}) => void} cb
 * @param {{maxNodes?:number, owners?:boolean, pollMs?:number, immediate?:boolean}} [opts]
 *        pollMs: fallback poll cadence (default 250). immediate: fire once at
 *        registration with diff:null (default true).
 * @returns {{stop:() => void, mode:"push"|"poll"}}
 */
export function watchGraph(roots, cb, {maxNodes, owners, pollMs = 250, immediate = true} = {}) {
    const snap = () => graph(roots, {maxNodes, owners});
    let prev = snap();
    if (immediate) cb({graph: prev, diff: null, mutations: 0, mode: HAS_HOOK ? "push" : "poll"});

    const flush = (mutations) => {
        const g = snap();
        const d = diff(prev, g);
        const changed = d.addedNodes.length || d.removedNodes.length || d.changedNodes.length ||
                        d.addedEdges.length || d.removedEdges.length;
        if (changed) { cb({graph: g, diff: d, mutations, mode: HAS_HOOK ? "push" : "poll"}); prev = g; }
    };

    if (HAS_HOOK) {
        let pending = 0, scheduled = false;
        const off = hubAdd(() => {
            pending++;
            if (!scheduled) {
                scheduled = true;
                queueMicrotask(() => { scheduled = false; const n = pending; pending = 0; flush(n); });
            }
        });
        return {stop: off, mode: "push"};
    }
    const t = every(pollMs, () => flush(0));
    return {stop: t, mode: "poll"};
}

// --- Recompute profiler (1.1, lite-signal >= 1.2.1 hook) -----------------------

/**
 * Count re-runs per node while active -- the hot-node detector. A computed that
 * re-evaluates 40,000 times behind one slider is invisible in a value snapshot
 * and obvious here.
 *
 * @param {{onSample?:(id:number, count:number) => void}} [opts]
 * @returns {{stop:() => Map<number,number>, counts:Map<number,number>,
 *           top:(n?:number) => Array<{id:number,count:number}>}|null}
 *          null when the engine lacks the graph-mutation hook
 *          (lite-signal < 1.2.1 -- check capabilities().mutationHook).
 */
export function profile({onSample} = {}) {
    if (!HAS_HOOK) return null;
    const counts = new Map();
    const off = hubAdd((op, a) => {
        if (op !== 5) return;
        const n = (counts.get(a) ?? 0) + 1;
        counts.set(a, n);
        if (onSample) onSample(a, n);
    });
    const top = (n = 10) => [...counts.entries()].map(([id, count]) => ({id, count}))
        .sort((x, y) => y.count - x.count).slice(0, n);
    return {stop: () => { off(); return counts; }, counts, top};
}

// --- Snapshot serialization (1.1) -----------------------------------------------

/**
 * JSON-safe form of a graph() result for offline viewing (the studio panel, a
 * bug report, a CI artifact). Non-primitive values are replaced by a typeof tag
 * -- a snapshot is a picture, not a live reference; bigints stringify with an
 * "n" suffix. Symbol-keyed walk handles are dropped by JSON itself.
 *
 * @param {{nodes:Array<object>, edges:Array<object>}} g  Output of graph().
 * @returns {string}  JSON string; parseable by deserialize().
 */
export function serialize(g) {
    const safe = (v) => {
        const t = typeof v;
        if (v === null || t === "number" || t === "string" || t === "boolean" || t === "undefined") return v;
        if (t === "bigint") return String(v) + "n";
        return "[" + t + "]";
    };
    return JSON.stringify({
        v: 1,
        ts: Date.now(),
        nodes: g.nodes.map((n) => ({id: n.id, kind: n.kind, value: safe(n.value)})),
        edges: g.edges,
    });
}

/**
 * Parse a serialize() string back into a plain {nodes, edges} graph -- shape-
 * compatible with toDot() and diff(), NOT re-walkable (descriptors are pictures
 * of nodes, the engine references are intentionally gone).
 *
 * @param {string} json  Output of serialize().
 * @returns {{v:number, ts:number, nodes:Array<object>, edges:Array<object>}}
 */
export function deserialize(json) {
    const g = JSON.parse(json);
    if (g === null || typeof g !== "object" || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
        throw new TypeError("deserialize: not a lite-devtools snapshot");
    }
    return g;
}
