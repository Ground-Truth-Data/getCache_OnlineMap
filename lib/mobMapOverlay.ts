import type { ImageSource, Map as MapboxMap } from "mapbox-gl";
import type { Coord } from "./coord";
import { glyphStack } from "./glyphStack";
import {
	getMapUrl,
	getVectorTileUrlTemplate,
	type OverlayHandle,
	readVectorTileSidecar,
} from "./mobMapStorage";

const IMAGE_SOURCE_ID = "map-overlay-image";
const RASTER_LAYER_ID = "map-overlay-raster";
const LABELS_SOURCE_ID = "map-overlay-labels";
const LABELS_LAYER_ID = "map-overlay-labels-text";

const VECTOR_SOURCE_ID = "map-overlay-vector";
const VECTOR_FILL_LAYER_ID = "map-overlay-vector-fill";
const VECTOR_LINE_LAYER_ID = "map-overlay-vector-line";
const VECTOR_CIRCLE_LAYER_ID = "map-overlay-vector-circle";
// tippecanoe's default source-layer name — the bake pipeline MUST keep this in sync, or the renderer mounts against the wrong name and nothing draws.
const VECTOR_SOURCE_LAYER = "features";

export interface OverlaySpec {
	/** Storage key returned by `saveMap(webpFile)`. */
	key: string;
	/** Image corners in Mapbox order: [topLeft, topRight, bottomRight, bottomLeft]. */
	corners: readonly [Coord, Coord, Coord, Coord];
	/** Distinguishes this overlay's ids from other overlays on the map; omit for the solo overlay (ids stay the bare constants). */
	slot?: string;
}

/** Every source/layer id is suffixed per overlay — without that, multiple overlays collide on one Mapbox source and only the last-added draws. Omitted slot yields the bare constant. */
function slotSuffix(slot?: string): string {
	return slot ? `-${slot}` : "";
}
const imageSourceId = (slot?: string) =>
	`${IMAGE_SOURCE_ID}${slotSuffix(slot)}`;
const rasterLayerId = (slot?: string) =>
	`${RASTER_LAYER_ID}${slotSuffix(slot)}`;
const labelsSourceId = (slot?: string) =>
	`${LABELS_SOURCE_ID}${slotSuffix(slot)}`;
const labelsLayerId = (slot?: string) =>
	`${LABELS_LAYER_ID}${slotSuffix(slot)}`;

// One blob handle per mounted overlay (keyed by slot) so removal can revoke its object URL on web — a single module-level handle would leak every overlay but the last.
const activeHandles = new Map<string, OverlayHandle>();

// Insert point for the overlay: below draw layers if present, else below the first symbol layer (keeps basemap labels on top), else top of stack.
function pickBeforeId(map: MapboxMap): string | undefined {
	const drawCandidates = ["draw-edges-halo", "completed-fill"];
	for (const id of drawCandidates) {
		if (map.getLayer(id)) return id;
	}
	const layers = map.getStyle()?.layers ?? [];
	const firstSymbol = layers.find((l) => l.type === "symbol");
	return firstSymbol?.id;
}

export async function addMapOverlay(
	map: MapboxMap,
	spec: OverlaySpec,
): Promise<void> {
	// Tear down only this slot — mounting a second overlay must not unmount the first.
	removeMapOverlay(map, spec.slot);

	const handle = await getMapUrl(spec.key);
	activeHandles.set(spec.slot ?? "", handle);

	map.addSource(imageSourceId(spec.slot), {
		type: "image",
		url: handle.url,
		coordinates: spec.corners as unknown as [
			[number, number],
			[number, number],
			[number, number],
			[number, number],
		],
	});

	map.addLayer(
		{
			id: rasterLayerId(spec.slot),
			type: "raster",
			source: imageSourceId(spec.slot),
			// 0.5 default — must stay in sync with the overlayOpacity store's default; tune live via setMapOverlayOpacity().
			paint: { "raster-opacity": 0.5 },
		},
		pickBeforeId(map),
	);

	// Deliberately does NOT move the camera — the importer/route frames a freshly imported overlay.
}

/** One label to draw over the raster; mirrors the proprietary OverlayLabel shape structurally since rapper stays UI-only and doesn't import it. */
export interface OverlayLabelSpec {
	/** Text, e.g. "2427". */
	t: string;
	/** Centre [lng, lat]. */
	p: [number, number];
	/** Text height in ground metres — drives zoom-proportional sizing. */
	m: number;
	/** Rotation, degrees clockwise, map-aligned. */
	r: number;
}

export function addMapOverlayLabels(
	map: MapboxMap,
	labels: readonly OverlayLabelSpec[],
	slot?: string,
): void {
	if (!map || !(map as unknown as { style?: unknown }).style) return;
	removeMapOverlayLabels(map, slot);
	if (!labels.length) return;
	// Screen px a label's height works out to at zoom 14 (m/px = 78271.517·cos(lat)/2^14) — anchor for the curve below.
	const px14 = (l: OverlayLabelSpec) =>
		(l.m * 16384) / (78271.517 * Math.cos((l.p[1] * Math.PI) / 180));
	// ⚠️ Per-feature sizing (["get","px14"] in the interpolate) fails SILENTLY — layer mounts, nothing draws. Use one per-layer curve anchored on the median size instead.
	const sizes = labels.map(px14).sort((a, b) => a - b);
	const med = sizes[Math.floor(sizes.length / 2)];
	const fc: GeoJSON.FeatureCollection = {
		type: "FeatureCollection",
		features: labels.map((l) => ({
			type: "Feature",
			properties: { t: l.t, rot: l.r },
			geometry: { type: "Point", coordinates: l.p },
		})),
	};
	map.addSource(labelsSourceId(slot), { type: "geojson", data: fc });
	map.addLayer(
		{
			id: labelsLayerId(slot),
			type: "symbol",
			source: labelsSourceId(slot),
			layout: {
				"text-field": ["get", "t"],
			// ⛔ NEVER a literal font stack — glyph endpoints are DISJOINT, so a fixed array 404s forever on one map; ask the live style (see glyphStack.ts).
			"text-font": glyphStack(map),
				// size = med * 2^(zoom-14) — text doubles per zoom step, exactly like the ground beneath it.
				"text-size": [
					"interpolate",
					["exponential", 2],
					["zoom"],
					6,
					med * 0.00390625,
					22,
					med * 256,
				],
				"text-rotate": ["get", "rot"],
				"text-rotation-alignment": "map",
				"text-pitch-alignment": "map",
				// Positions are exact (from the PDF) — allow-overlap/ignore-placement stay true so Mapbox's collision pass never hides a label.
				"text-allow-overlap": true,
				"text-ignore-placement": true,
				"text-padding": 0,
			},
			paint: {
				"text-color": "#14181c",
				"text-halo-color": "rgba(247, 245, 239, 0.92)",
				"text-halo-width": 1.6,
			},
		},
		pickBeforeId(map),
	);
}

/** Tear down the crisp-label layer. Safe when nothing is mounted. */
export function removeMapOverlayLabels(map: MapboxMap, slot?: string): void {
	if (!map || !(map as unknown as { style?: unknown }).style) return;
	const slots =
		slot !== undefined ? [slot] : [...new Set([...activeHandles.keys(), ""])];
	for (const s of slots) {
		if (map.getLayer(labelsLayerId(s))) map.removeLayer(labelsLayerId(s));
		if (map.getSource(labelsSourceId(s))) map.removeSource(labelsSourceId(s));
	}
}

/** Unmount overlays. Pass a slot to remove just that one; omit it to remove every mounted overlay (map switch, style reload, teardown). */
export function removeMapOverlay(map: MapboxMap, slot?: string): void {
	// Slots this call handles: an explicit slot narrows to one; otherwise every slot with a handle, plus "" so a solo overlay recorded before any handle still gets swept.
	const slots =
		slot !== undefined ? [slot] : [...new Set([...activeHandles.keys(), ""])];
	// Style can be undefined here (slow device, or map torn down mid-navigation) — getLayer/getSource then throw; bail but still drop the object-URL handles so they don't leak.
	if (!map || !(map as unknown as { style?: unknown }).style) {
		for (const s of slots) {
			const h = activeHandles.get(s);
			if (h) {
				h.revoke();
				activeHandles.delete(s);
			}
		}
		return;
	}
	for (const s of slots) {
		removeMapOverlayLabels(map, s);
		if (map.getLayer(rasterLayerId(s))) {
			map.removeLayer(rasterLayerId(s));
		}
		if (map.getSource(imageSourceId(s))) {
			map.removeSource(imageSourceId(s));
		}
	}
	// Vector pyramid teardown: order matters — Mapbox refuses to remove a source while a layer still references it.
	for (const id of [
		VECTOR_FILL_LAYER_ID,
		VECTOR_LINE_LAYER_ID,
		VECTOR_CIRCLE_LAYER_ID,
	]) {
		if (map.getLayer(id)) map.removeLayer(id);
	}
	if (map.getSource(VECTOR_SOURCE_ID)) {
		map.removeSource(VECTOR_SOURCE_ID);
	}
	for (const s of slots) {
		const h = activeHandles.get(s);
		if (h) {
			h.revoke();
			activeHandles.delete(s);
		}
	}
}

/** Set raster opacity. With a slot, only that overlay changes; without one, every mounted overlay does (the global slider). */
export function setMapOverlayOpacity(
	map: MapboxMap,
	opacity: number,
	slot?: string,
): void {
	if (!map || !(map as unknown as { style?: unknown }).style) return;
	const slots =
		slot !== undefined ? [slot] : [...new Set([...activeHandles.keys(), ""])];
	for (const s of slots) {
		if (map.getLayer(rasterLayerId(s))) {
			map.setPaintProperty(rasterLayerId(s), "raster-opacity", opacity);
		}
	}
}

/** Show/hide the mounted overlay without unmounting it — flips layout visibility, so a toggle never pays the re-decode/re-mount cost of remove+add. */
export function setMapOverlayVisibility(
	map: MapboxMap,
	visible: boolean,
	slot?: string,
): void {
	if (!map || !(map as unknown as { style?: unknown }).style) return;
	const value = visible ? "visible" : "none";
	const slots =
		slot !== undefined ? [slot] : [...new Set([...activeHandles.keys(), ""])];
	const ids = slots.flatMap((s) => [rasterLayerId(s), labelsLayerId(s)]);
	// The vector pyramid is per-map (one bake), not per-slot — toggled once.
	if (slot === undefined) {
		ids.push(
			VECTOR_FILL_LAYER_ID,
			VECTOR_LINE_LAYER_ID,
			VECTOR_CIRCLE_LAYER_ID,
		);
	}
	for (const id of ids) {
		if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
	}
}

/** Swap the overlay's backing blob in place (gap-free, via ImageSource.updateImage) — unlike addMapOverlay's remove+add, this never flashes the basemap through a gap. Returns false if there's no live image source to swap. */
export async function swapMapOverlayImage(
	map: MapboxMap,
	spec: OverlaySpec,
): Promise<boolean> {
	const source = map.getSource(imageSourceId(spec.slot));
	if (!source || (source as { type?: string }).type !== "image") return false;
	const handle = await getMapUrl(spec.key);
	const prev = activeHandles.get(spec.slot ?? "");
	(source as ImageSource).updateImage({
		url: handle.url,
		coordinates: spec.corners as unknown as [
			[number, number],
			[number, number],
			[number, number],
			[number, number],
		],
	});
	activeHandles.set(spec.slot ?? "", handle);
	// Old texture is already in the GPU and Mapbox is now fetching the new url, so the old objectURL is safe to revoke — no gap on screen.
	if (prev) prev.revoke();
	return true;
}

export interface VectorTileOverlaySpec {
	/** mapKey — used to locate the on-disk vtiles tree. */
	mapKey: string;
}

export async function addMapVectorTileOverlay(
	map: MapboxMap,
	spec: VectorTileOverlaySpec,
): Promise<boolean> {
	const sidecar = await readVectorTileSidecar(spec.mapKey);
	if (!sidecar) return false;

	removeMapOverlay(map);

	const template = await getVectorTileUrlTemplate(spec.mapKey);

	map.addSource(VECTOR_SOURCE_ID, {
		type: "vector",
		tiles: [template],
		minzoom: sidecar.minzoom,
		maxzoom: sidecar.maxzoom,
		bounds: [
			sidecar.bounds.w,
			sidecar.bounds.s,
			sidecar.bounds.e,
			sidecar.bounds.n,
		],
	});

	const beforeId = pickBeforeId(map);

	// Polygons — fill-color/fill-opacity read simplestyle-spec props (via tippecanoe -y) or fall back to a neutral terracotta tint.
	map.addLayer(
		{
			id: VECTOR_FILL_LAYER_ID,
			type: "fill",
			source: VECTOR_SOURCE_ID,
			"source-layer": VECTOR_SOURCE_LAYER,
			filter: ["==", ["geometry-type"], "Polygon"],
			paint: {
				"fill-color": ["coalesce", ["get", "fill"], "#c4744a"],
				"fill-opacity": [
					"coalesce",
					["to-number", ["get", "fill-opacity"]],
					0.35,
				],
				"fill-outline-color": ["coalesce", ["get", "stroke"], "#7b3f1f"],
			},
		},
		beforeId,
	);

	// Lines: covers true LineString features — polygon outlines already come from fill-outline-color above.
	map.addLayer(
		{
			id: VECTOR_LINE_LAYER_ID,
			type: "line",
			source: VECTOR_SOURCE_ID,
			"source-layer": VECTOR_SOURCE_LAYER,
			filter: ["==", ["geometry-type"], "LineString"],
			paint: {
				"line-color": ["coalesce", ["get", "stroke"], "#7b3f1f"],
				"line-width": ["coalesce", ["to-number", ["get", "stroke-width"]], 2],
				"line-opacity": [
					"coalesce",
					["to-number", ["get", "stroke-opacity"]],
					0.9,
				],
			},
		},
		beforeId,
	);

	// Points — rendered as circles for v1; custom KMZ icons are later Phase 5 work.
	map.addLayer(
		{
			id: VECTOR_CIRCLE_LAYER_ID,
			type: "circle",
			source: VECTOR_SOURCE_ID,
			"source-layer": VECTOR_SOURCE_LAYER,
			filter: ["==", ["geometry-type"], "Point"],
			paint: {
				"circle-color": ["coalesce", ["get", "marker-color"], "#c4744a"],
				"circle-radius": 5,
				"circle-stroke-color": "#ffffff",
				"circle-stroke-width": 1.5,
			},
		},
		beforeId,
	);

	return true;
}
