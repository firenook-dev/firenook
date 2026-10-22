# The former name

[Docs](README.md) · The former name

Firenook (formerly Fireside) is the same project under its new name: the last
release under the old name was `@fireside-dev/cli@0.1.0-next.9`, and every
release from `0.2.0-next.1` on is published as `firenook`. To migrate, replace
`@fireside-dev/cli` with `firenook` in `package.json`, the `fireside` command
with `firenook`, every `FIRESIDE_*` environment variable with its `FIRENOOK_*`
counterpart, and the `.fireside/` run directory with `.firenook/`; persisted
suite state is adopted in place on the first start, and an Extension source
cached or vendored with a `fireside-registry.json` sidecar still starts
offline (`firenook ext:vendor` rewrites a vendored copy's sidecar as
`firenook-registry.json`).
