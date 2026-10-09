// `knowtarium`: the root entry re-exports `knowtarium/core`. Import `crypto`, `protocol` and
// `client` through their own subpaths, so a consumer only loads what it uses.
export * from "./core/index.js";
