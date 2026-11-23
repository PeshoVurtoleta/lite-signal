// bench/lib/title.mjs -- port of src perfLogging.makeTitle + benchMetadata, so the
// mirror emits the SAME test-title string Andrii's log uses. His test column is
//   `${makeTitle(config)} (${config.name})`  truncated to 60 chars.
// Emitting the raw config.name instead is why the first join matched 0 rows. The mirror
// emits the title UNtruncated, so the two sides agree only on joinKey() below.

function percent(n) { return Math.round(n * 100) + "%"; }

export function makeTitle(config) {
    const {
        width, totalLayers, staticFraction, nSources, sourcesCount, fanIn,
        readFraction, mode, graphKind = "rect", updatesPerIteration = 1,
        warmupIterations = 0, sinkReadMode,
    } = config;
    const dyn = staticFraction < 1 ? " - dynamic" : "";
    const read = readFraction < 1 ? ` - read ${percent(readFraction)}` : "";
    const execMode = mode && mode !== "mixed" ? ` - ${mode}` : "";
    const sources = ` - ${nSources} sources`;
    const dagShape = graphKind === "rect"
        ? `${width}x${totalLayers}`
        : `${sourcesCount ?? width}->${width}x${totalLayers} - fanIn ${fanIn ?? nSources}`;
    const graphLabel = graphKind === "rect" ? "" : ` - ${graphKind}`;
    const burst = updatesPerIteration > 1 ? ` - burst ${updatesPerIteration}` : "";
    const warmup = warmupIterations > 0 ? ` - warm ${warmupIterations}` : "";
    const sinkMode = sinkReadMode && sinkReadMode !== "per-update" ? ` - ${sinkReadMode}` : "";
    return `${dagShape}${graphLabel}${sources}${dyn}${read}${execMode}${burst}${warmup}${sinkMode}`;
}

// The full test column (title + name in parens), untruncated. His log cuts this column at
// columnWidth.test = 60 chars and pads it; the mirror's pad() pads but NEVER truncates,
// so a local row carries the full string (7 of the 47 titles are longer than 60).
export function testColumn(config) {
    return `${makeTitle(config)} (${config.name || ""})`;
}

// The join key both sides reduce to: the first 60 chars (his column width), trailing
// spaces trimmed (his CSV cell is trimmed, and a cut can end on a space). Joining on the
// raw title silently dropped every long row; two titles that share a key cannot be told
// apart in his log, so a caller must refuse a key collision, never pick one.
export function joinKey(s) {
    return s.slice(0, 60).trimEnd();
}

function estimateNodes(config) {
    const { width, totalLayers, sourcesCount = width } = config;
    return sourcesCount + width * (totalLayers - 1);
}

export function metadata(config) {
    const dynamicFraction = 1 - config.staticFraction;
    const graphKind = config.graphKind ?? "rect";
    const nodes = estimateNodes(config);
    const family = graphKind === "diamond-mesh" ? "diamond mesh"
        : graphKind === "layered-dag" ? "layered DAG"
            : dynamicFraction > 0 ? "dynamic rectangular DAG" : "stable rectangular DAG";
    const group = dynamicFraction > 0 ? "dynamic" : nodes >= 10_000 ? "large_graph" : "pull";
    return { group, family };
}
