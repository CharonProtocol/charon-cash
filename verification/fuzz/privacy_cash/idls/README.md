# IDLs for Crucible fuzz harness

Drop the Anchor IDL JSON for `charon` here as `charon.json`. The simplest
path:

```
# from the program crate root:
anchor build
cp target/idl/charon.json ../path/to/fuzz/charon/idls/charon.json
```

`qedgen probe --fuzz` will look up `target/idl/charon.json` and symlink it
into this directory automatically if it exists. Manual copy is the
fallback when discovery doesn't apply (Codama / non-Anchor / hand-rolled).

The IDL must be in Anchor 0.30+ format. Anchor 0.29 IDLs need
`anchor idl convert` first.
