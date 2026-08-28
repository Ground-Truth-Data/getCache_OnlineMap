# Camera mutations — the safeMap rule

> Carved out of the parent's `ReTreever/src/lib/mobile/docs/mapDocs.md` on 28 Aug 2026 so the
> rule lives beside `lib/safeMap.ts`. Bare `src/…` and `scripts/…` paths below are
> ReTreever-relative; `getCache_OnlineMap/…` paths are this repo.

**Every camera mutation goes through `getCache_OnlineMap/lib/safeMap.ts`. No exceptions.**
Direct `map.flyTo`, `fitBounds`, `easeTo`, `jumpTo`, `setCenter`, `setZoom` are
banned by `scripts/check-direct-mapbox-camera.sh`, which runs in CI.

### Current known violations — triaged 2026-08-23, don't re-panic

The guard had been scanning only `src/`, because it grepped a folder renamed to
`harness/` and swallowed the error (`2>/dev/null || true`). Repointed, it
reports **7** sites, not 4. **Triaged: six are guarded, one is not.**

| site | verdict |
|---|---|
| `src/routes/(getcache)/map/mapFramer.ts:290` | `Number.isFinite` on both coords **plus** a null-island `(0,0)` reject. Safest of the seven. |
| `src/lib/mobile/components/mobMap/pinMarkers.ts:441` | guarded by `isFiniteCoord` on the line above |
| `getCache_OnlineMap/lib/mapDraw.ts:736` | guarded by `.every(Number.isFinite)` above |
| `getCache_OnlineMap/lib/mapDraw.ts:746` | `parseBbox` returns early on a bad bbox |
| `src/lib/mobile/stores/mapViewport.ts:211-212` | `setBearing(0)` / `setPitch(0)` — literals, cannot be NaN |
| **`getCache_OnlineMap/lib/mapGrid.ts:1094`** | ⚠️ **the real one.** Feeds an unvalidated `cam.unproject()` result straight into `easeTo`. Unproject on a mid-gesture or degenerate camera is exactly the NaN source §"NaN can also enter through SOURCES and MARKERS" describes. |

So the guard is doing its job — it forbids the *pattern*, and the pattern is
what rots. But only `mapGrid.ts:1094` is a live NaN risk; the rest want a
mechanical swap to `safeEaseTo`/`safeFlyTo` (or a documented allow), not a
rescue. Fix `mapGrid` first.

### Why

Mapbox's `_calcMatrices` is the choke point of the render pipeline. One NaN
reaching it (lng, lat, zoom, bearing, padding, offset) corrupts the camera's
internal state, and once corrupt **every subsequent call** — even a valid one —
crashes with `Cannot read properties of null (reading '3')`. Fixing one call
site does not help; the next call inherits the corruption.

`safeMap.ts` does three things at every entry:

1. Validate inputs are finite (reject + log if not).
2. Detect already-corrupt camera state and `jumpTo` a clean one first.
3. `map.stop()` to cancel in-flight animations, preventing stacked transitions.

```ts
import { safeFlyTo, safeFitBounds }
    from "$parent/siblings/getCache_OnlineMap/lib/safeMap";

safeFlyTo(map, { center: [lng, lat], zoom: 14, duration: 1200 });
```

`safeFitBounds` falls back to `safeFlyTo` for degenerate single-point bounds —
no `if (sw === ne)` branching at call sites.

Wanting to add an inline `Number.isFinite` guard before a camera call means
extending `safeMap.ts`, not duplicating the guard.

### NaN also enters through SOURCES and MARKERS

`safeMap.ts` guards camera inputs only. A NaN still crashes Mapbox if it lands
in a GeoJSON source's `coordinates`, a `Marker.setLngLat()`, or a
`map.project()` / `unproject()` argument.

That crash **looks different**: typically `Invalid LngLat object: (NaN, NaN)`
from inside Mapbox's render pass (`_evaluateOpacity`, `pointLocation3D`) with
no user code in the trace. That's the tell — a render-time unproject of bad
data, not a camera call.

Common upstream sources: `e.lngLat` from `touchmove` during a pinch (Mapbox
emits `(NaN, NaN)` mid-gesture), math on drawn vertices before the second
exists, malformed imported KML/GeoJSON, geolocation before the first fix.

**Rule:** validate before writing to a source or marker, reusing the helpers
`safeMap.ts` already exports, so the gate stays one piece of code:

```ts
import { isFiniteCoord, isFiniteLngLat }
    from "$parent/siblings/getCache_OnlineMap/lib/safeMap";

if (!isFiniteLngLat(e.lngLat)) return;
const safe = coords.filter(isFiniteCoord);
```

Never patch the symptom inside Mapbox internals — find the upstream write.

---

