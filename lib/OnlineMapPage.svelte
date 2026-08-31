<script lang="ts">
/**
 * The Get Cache online map — the REAL one, not the where/org globe.
 * Mirrors OfflineMapPage.svelte in the offline child: the child owns the
 * page, the host hands in its data through one ports object
 * (./shared/hostPorts). No ports → the map renders with no pins.
 *
 * Deliberately NOT mapPage.svelte: that component is the where map —
 * globe projection, autorotate, org markers, info panels. This page is a
 * bare initializeMap on `defaultOptions` (flat satellite-streets) plus the
 * host's clustered pins, camera fitted to them.
 */
import type { Map as MapboxMap } from "mapbox-gl";
import { onMount } from "svelte";
import { page } from "$app/stores";
import "mapbox-gl/dist/mapbox-gl.css";
// The child carries its own stylesheet — see the note in mapPage.svelte.
import "./map.css";
import { initializeMap } from "./mapInit";
import { addClusteredPins } from "./mapMarker";
import type { OnlineMapHostPorts } from "./shared/hostPorts";
import { portal } from "$rig/dev/portal";

let {
	ports = null,
	debugHost = undefined,
}: { ports?: OnlineMapHostPorts | null; debugHost?: HTMLElement } = $props();

const dev = import.meta.env.DEV;
let devCamera = $state("");

let mapContainer: HTMLDivElement;
let mapInstance = $state<MapboxMap | null>(null);

onMount(() => {
	const cleanup = initializeMap(mapContainer, {
		onMapReady: (map) => {
			mapInstance = map;
			if (dev) {
				const writeCamera = () => {
					const c = map.getCenter();
					devCamera = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)} · z${map.getZoom().toFixed(2)}`;
				};
				writeCamera();
				map.on("moveend", writeCamera);
			}
		},
	});
	return cleanup;
});

// `?map=` deep link — waits for hydration; an unknown key just keeps the current map.
$effect(() => {
	const store = ports?.store;
	if (!store) return;
	const wanted = $page.url.searchParams.get("map");
	if (!store.ready || !wanted || wanted === store.activeMapKey) return;
	if (store.allMaps.some((m) => m.mapKey === wanted)) store.switchMap(wanted);
});

// The active map's own point pins, pushed into a clustered GL source. Hiding a
// kind (Legend toggles: `plot:*` → plots, rest → pins) filters the FEED —
// re-running setData is the whole visibility mechanism, so the layers never
// need touching and un-hiding is just the unfiltered push.
const PIN_SOURCE = "store-pins";
$effect(() => {
	const map = mapInstance;
	const store = ports?.store;
	if (!map || !store?.ready) return;
	const pins = store.features.filter((f) => {
		if (f.geometry?.type !== "Point") return false;
		const t = String(f.properties?.pinTypeKey ?? "pin");
		return t.startsWith("plot:")
			? (ports?.visible?.plots ?? true)
			: (ports?.visible?.pins ?? true);
	});
	addClusteredPins(map, {
		id: PIN_SOURCE,
		data: { type: "FeatureCollection", features: pins },
	});
	fitToPinsOnce(map, pins);
});

// First hydration only: land the camera on the user's pins instead of the
// default centre. Never re-fires — after that the camera is the user's.
let didFit = false;
function fitToPinsOnce(map: MapboxMap, pins: { geometry?: { type?: string; coordinates?: unknown } }[]) {
	if (didFit || pins.length === 0) return;
	let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
	for (const p of pins) {
		const c = p.geometry?.coordinates;
		if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
		minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
		minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
	}
	if (!Number.isFinite(minLng)) return;
	didFit = true;
	map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 60, maxZoom: 12, duration: 0 });
}
</script>

<div class="viewport-layout">
	<main class="mob-map-area">
		<div bind:this={mapContainer} class="mapbox-map"></div>
		{#if dev}
			<output class="dev-readout" use:portal={debugHost} aria-live="polite">
				<span class="k">online map</span> · mob
				{#if devCamera}<br />{devCamera}{/if}
			</output>
		{/if}
	</main>
</div>

<style>
	/* The dev read-out, when no host takes it: a pill over the map. */
	.dev-readout {
		position: absolute;
		top: 40px;
		right: 12px;
		z-index: 50;
		padding: 4px 10px;
		border-radius: 10px;
		background: rgb(0 0 0 / 0.78);
		color: #ddd;
		font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
		pointer-events: none;
	}
	.dev-readout .k {
		color: #e8b923;
		font-weight: 700;
	}

	/* THE MAP IS ITS SLOT — same rule as mapPage.svelte: fill the nearest
	   positioned ancestor edge to edge, never measure the browser window. */
	.viewport-layout {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		overscroll-behavior: none;
	}
	.mob-map-area {
		display: flex;
		position: relative;
		flex: 1;
		min-height: 0;
		width: 100%;
		box-sizing: border-box;
	}
	.mapbox-map {
		position: absolute;
		inset: 0;
		overscroll-behavior: none;
	}
</style>
