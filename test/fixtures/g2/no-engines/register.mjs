// node --import <this file>: 'alien-signals' and 'reflex-quant' become unresolvable
// (resolve throws ERR_MODULE_NOT_FOUND), as in a bench/ copy whose node_modules lacks them.
import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
