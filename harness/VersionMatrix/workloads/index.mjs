// Workload registry. Each maps to a bench-benchmark row cited in public claims.
import * as mix from './reactive-graph-mix.mjs';
import * as deep from './deep-chain.mjs';
import * as broadcast from './broadcast-fanout.mjs';
import * as churn from './dynamic-dep-churn.mjs';
import * as creation from './creation-churn.mjs';

export const WORKLOADS = { [mix.name]: mix, [deep.name]: deep, [broadcast.name]: broadcast, [churn.name]: churn, [creation.name]: creation };
export const NAMES = Object.keys(WORKLOADS);
export function get(name) { const w = WORKLOADS[name]; if (!w) throw new Error('unknown workload: ' + name + ' (have: ' + NAMES.join(', ') + ')'); return w; }
