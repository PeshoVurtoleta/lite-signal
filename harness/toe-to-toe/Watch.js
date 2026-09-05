// Resolution shim for harness/toe-to-toe -- NOT an engine file.
//
// The frozen engine snapshots in ./engines/<v>/Signal.js end with
//     export {watch, when, whenAsync} from "../../Watch.js";
// which, at their original scratch depth, resolved to the repo-root Watch.js.
// From ./engines/<v>/ that specifier now lands here, so this file forwards to the
// real one. The sweep never calls watch/when/whenAsync -- the re-export only has
// to RESOLVE -- so forwarding preserves the original behavior byte-for-byte while
// leaving the snapshots unmodified (they are the artifacts under measurement).
export {watch, when, whenAsync} from "../../Watch.js";
