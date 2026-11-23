const STUBBED = new Set(["alien-signals", "reflex-quant", "@preact/signals-core", "solid-js/dist/solid.js"]);
const STUB_URL = new URL("./engine-stub.mjs", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
    if (STUBBED.has(specifier)) return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
}
