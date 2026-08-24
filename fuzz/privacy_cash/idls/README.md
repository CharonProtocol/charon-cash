# IDLs for Crucible fuzz harness

Drop the Anchor IDL JSON for `privacy_cash` here as `privacy_cash.json`. The simplest
path:

```
# from the program crate root:
anchor build
cp target/idl/privacy_cash.json ../path/to/fuzz/privacy_cash/idls/privacy_cash.json
```

`qedgen probe --fuzz` will look up `target/idl/privacy_cash.json` and symlink it
into this directory automatically if it exists. Manual copy is the
fallback when discovery doesn't apply (Codama / non-Anchor / hand-rolled).

The IDL must be in Anchor 0.30+ format. Anchor 0.29 IDLs need
`anchor idl convert` first.
