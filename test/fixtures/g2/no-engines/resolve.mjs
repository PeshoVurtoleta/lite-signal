const MISSING = new Set(["alien-signals", "reflex-quant"]);
export async function resolve(specifier, context, nextResolve) {
    if (MISSING.has(specifier)) {
        const e = new Error("Cannot find package '" + specifier + "' (g2 no-engines hook)");
        e.code = "ERR_MODULE_NOT_FOUND";
        throw e;
    }
    return nextResolve(specifier, context);
}
