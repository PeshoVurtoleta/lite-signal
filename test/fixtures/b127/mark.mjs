// b127 marker for the --trace-elements-transitions row: each call makes transitions that V8 prints as located in THIS file.
export function mark() {
    const a = [1]; a[0] = 1.5;     // PACKED_SMI -> PACKED_DOUBLE
    const b = [1]; b.push("x");    // PACKED_SMI -> PACKED
    globalThis.__b127mark = [a, b];
}
