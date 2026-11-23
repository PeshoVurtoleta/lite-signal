// node --import <this file>: maps the four comparison-engine specifiers to a stub module
// whose exports throw when called, so a child run touches the lite engine only.
import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
