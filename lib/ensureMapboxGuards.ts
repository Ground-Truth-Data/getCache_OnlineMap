// Memoized, lazy installer for the Mapbox NaN prototype guards.
//
// The guards (the harness `safeMarker.installMapboxNanGuards`) patch mapbox-gl's
// Marker / Popup / Map / GeoJSONSource prototypes and MUST be in place before
// the first `new mapboxgl.Map(...)`. They used to be installed *synchronously*
// at client boot in `hooks.client.ts` — which forced the whole ~1.8 MB
// mapbox-gl bundle into the app shell on EVERY route, map-less marketing /
// search / admin pages included (see perf/BASELINE.md).
//
// This helper loads `safeMarker` (and therefore mapbox-gl) via a dynamic
// import and memoizes the install so it runs exactly once per session:
//   • dt-web map surfaces `await ensureMapboxGuards()` before building their
//     map — a hard ordering guarantee, no race.
//   • `hooks.client.ts` fires it once at boot (fire-and-forget) so mobile /
//     native map screens still find the guards installed by the time they
//     mount, without mapbox sitting in the initial, render-blocking bundle.
//
// The underlying guards are idempotent (each patches behind a `Symbol.for`
// sentinel), so calling this from several map sites in one session is safe.

let installed: Promise<void> | undefined;

export function ensureMapboxGuards(): Promise<void> {
	if (!installed) {
		installed = import("./safeMarker").then(
			({ installMapboxNanGuards }) => installMapboxNanGuards(),
		);
	}
	return installed;
}
