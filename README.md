# getCache_OnlineMap

The online Mapbox map child of Get Cache. Mounted by `rapper/` or served by
`ReTreever/` through the `$parent` alias — see the parent's `CLAUDE.md`.

## Docs

- [`docs/SAFE_MAP.md`](./docs/SAFE_MAP.md) — **every camera mutation goes
  through `lib/safeMap.ts`**: the rule, why one NaN corrupts the camera for
  good, the triaged violation table, and the sources/markers corollary.

The map index (UX principles, what-not-to-do, pointers to every owner) stays in
the parent at `ReTreever/src/lib/mobile/docs/mapDocs.md`.
