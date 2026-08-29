// Distinct source/layer ids from mobMapOverlay so the two never collide (box can be up while the real overlay mounts).

import type { Map as MapboxMap } from "mapbox-gl";
import type { Coord } from "./coord";

const BOX_SOURCE_ID = "map-waiting-box";
const BOX_FILL_LAYER_ID = "map-waiting-box-fill";
const BOX_LINE_LAYER_ID = "map-waiting-box-line";
const ANIM_SOURCE_ID = "map-waiting-anim";
const ANIM_LAYER_ID = "map-waiting-anim-layer";

// Individual frames (not the single .webp) because drawImage() of an animated image only ever draws its first frame — symlinked into ReTreever/static so the path resolves everywhere.
const ANIM_FRAME_URL = (n: number) =>
	`/mobileAssets/animations/cleanCache_anime/${n}_cleanCache_anime.webp`;
const ANIM_FRAME_COUNT = 11;
const ANIM_FRAME_MS = 500; // matches the built .webp's per-frame duration
const ANIM_CANVAS_PX = 500; // native frame resolution

// One waiting box at a time; the frame ticker + canvas are held so hideWaitingBox can stop and drop them.
let animTimer: ReturnType<typeof setInterval> | null = null;
let animCanvas: HTMLCanvasElement | null = null;
let animFrames: HTMLImageElement[] = [];

// A show requested before the style loads is queued for the map's load event (not silently dropped) — cancelled by hideWaitingBox.
let pendingShowCorners: readonly [Coord, Coord, Coord, Coord] | null = null;

function styleReady(map: MapboxMap): boolean {
	return !!map && !!(map as unknown as { style?: unknown }).style;
}

/** [TL, TR, BR, BL] → a closed GeoJSON ring [TL, TR, BR, BL, TL]. */
function ringFromCorners(
	corners: readonly [Coord, Coord, Coord, Coord],
): [number, number][] {
	const [tl, tr, br, bl] = corners;
	return [
		[tl[0], tl[1]],
		[tr[0], tr[1]],
		[br[0], br[1]],
		[bl[0], bl[1]],
		[tl[0], tl[1]],
	];
}

/** Centre of the quad (average of the 4 corners) — where the animation sits. */
function centreOf(
	corners: readonly [Coord, Coord, Coord, Coord],
): [number, number] {
	let lng = 0;
	let lat = 0;
	for (const c of corners) {
		lng += c[0];
		lat += c[1];
	}
	return [lng / 4, lat / 4];
}

/** Geographic square (~3/4 of the slab's shorter side) for the animation canvas — metres-based so it stays square on screen; raw degrees would squash it since 1° longitude shrinks with cos(lat). */
function innerSquareQuad(
	corners: readonly [Coord, Coord, Coord, Coord],
): [[number, number], [number, number], [number, number], [number, number]] {
	const [clng, clat] = centreOf(corners);
	const mPerDegLat = 110_540;
	const mPerDegLng = 111_320 * Math.cos((clat * Math.PI) / 180);
	const lngs = corners.map((c) => c[0]);
	const lats = corners.map((c) => c[1]);
	const widthM = (Math.max(...lngs) - Math.min(...lngs)) * mPerDegLng;
	const heightM = (Math.max(...lats) - Math.min(...lats)) * mPerDegLat;
	const sideM = Math.min(widthM, heightM) * 0.75;
	const halfLng = sideM / 2 / mPerDegLng;
	const halfLat = sideM / 2 / mPerDegLat;
	return [
		[clng - halfLng, clat + halfLat],
		[clng + halfLng, clat + halfLat],
		[clng + halfLng, clat - halfLat],
		[clng - halfLng, clat - halfLat],
	];
}

/** Insert the box below labels (same rule as the real overlay) so place names stay readable on top of it. */
function pickBeforeId(map: MapboxMap): string | undefined {
	for (const id of ["draw-edges-halo", "completed-fill"]) {
		if (map.getLayer(id)) return id;
	}
	const layers = map.getStyle()?.layers ?? [];
	return layers.find((l) => l.type === "symbol")?.id;
}

/** Show the waiting placeholder on corners ([TL,TR,BR,BL], same order as the real overlay). Idempotent — calling again re-points an existing box. Does NOT move the camera; the importer frames the spot. */
export function showWaitingBox(
	map: MapboxMap,
	corners: readonly [Coord, Coord, Coord, Coord],
): void {
	if (!styleReady(map)) {
		const firstQueued = pendingShowCorners === null;
		pendingShowCorners = corners;
		if (firstQueued) {
			map.once("load", () => {
				const queued = pendingShowCorners;
				pendingShowCorners = null;
				if (queued) showWaitingBox(map, queued);
			});
		}
		return;
	}
	pendingShowCorners = null;

	const fc: GeoJSON.FeatureCollection = {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				properties: {},
				geometry: {
					type: "Polygon",
					coordinates: [ringFromCorners(corners)],
				},
			},
		],
	};

	const existing = map.getSource(BOX_SOURCE_ID);
	if (existing && "setData" in existing) {
		(existing as mapboxgl.GeoJSONSource).setData(fc);
	} else {
		map.addSource(BOX_SOURCE_ID, { type: "geojson", data: fc });
		const beforeId = pickBeforeId(map);
		map.addLayer(
			{
				id: BOX_FILL_LAYER_ID,
				type: "fill",
				source: BOX_SOURCE_ID,
				// Dark slate + near-opaque (0.92) — reads as a placeholder slab, not a hole in the map.
				paint: { "fill-color": "#31383f", "fill-opacity": 0.92 },
			},
			beforeId,
		);
		map.addLayer(
			{
				id: BOX_LINE_LAYER_ID,
				type: "line",
				source: BOX_SOURCE_ID,
				paint: { "line-color": "#ffffff", "line-width": 2 },
			},
			beforeId,
		);
	}

	// Animation is mounted ON the slab as a CanvasSource (not a DOM overlay), so it pans/scales welded to the box; animate: true keeps Mapbox re-uploading the canvas texture.
	const animQuad = innerSquareQuad(corners);
	const existingAnim = map.getSource(ANIM_SOURCE_ID);
	if (existingAnim && "setCoordinates" in existingAnim) {
		(
			existingAnim as unknown as {
				setCoordinates: (c: number[][]) => void;
			}
		).setCoordinates(animQuad as unknown as number[][]);
		return;
	}
	if (!animCanvas) {
		animCanvas = document.createElement("canvas");
		animCanvas.width = ANIM_CANVAS_PX;
		animCanvas.height = ANIM_CANVAS_PX;
	}
	if (animFrames.length === 0) {
		animFrames = Array.from({ length: ANIM_FRAME_COUNT }, (_, i) => {
			const img = new Image();
			img.src = ANIM_FRAME_URL(i + 1);
			return img;
		});
	}
	const ctx = animCanvas.getContext("2d");
	let frame = 0;
	if (animTimer) clearInterval(animTimer);
	const drawFrame = () => {
		const img = animFrames[frame % ANIM_FRAME_COUNT];
		frame += 1;
		if (!ctx || !img?.complete || img.naturalWidth === 0) return;
		ctx.clearRect(0, 0, ANIM_CANVAS_PX, ANIM_CANVAS_PX);
		ctx.drawImage(img, 0, 0, ANIM_CANVAS_PX, ANIM_CANVAS_PX);
	};
	drawFrame();
	animTimer = setInterval(drawFrame, ANIM_FRAME_MS);
	map.addSource(ANIM_SOURCE_ID, {
		type: "canvas",
		canvas: animCanvas,
		coordinates: animQuad,
		animate: true,
	});
	map.addLayer(
		{
			id: ANIM_LAYER_ID,
			type: "raster",
			source: ANIM_SOURCE_ID,
			paint: { "raster-fade-duration": 0 },
		},
		pickBeforeId(map),
	);
}

/** Tear down the waiting box only once the real overlay is actually ON SCREEN — hiding on addMapOverlay's resolve (not the first rendered frame after load) leaves a blank beat before the image paints. */
// NEVER gate this on `idle` — the animation's CanvasSource keeps the map perpetually re-rendering, so idle only fires via the guard timeout and the box overstays ~10s.
// The timeout is a never-strand guard only — hides anyway if the overlay never loads.
export function hideWaitingBoxOnceRendered(
	map: MapboxMap,
	overlaySourceId = "map-overlay-image",
): void {
	if (!styleReady(map)) {
		hideWaitingBox(map);
		return;
	}
	let settled = false;
	const done = () => {
		if (settled) return;
		settled = true;
		map.off("sourcedata", onSourceData);
		map.off("render", onPainted);
		clearTimeout(guard);
		hideWaitingBox(map);
	};
	// One rendered frame AFTER the overlay image is loaded ⇒ it's on screen.
	const onPainted = () => done();
	const armPaint = () => {
		map.off("sourcedata", onSourceData);
		map.once("render", onPainted);
	};
	const onSourceData = (e: { sourceId?: string }) => {
		if (e.sourceId !== overlaySourceId) return;
		if (map.isSourceLoaded(overlaySourceId)) armPaint();
	};
	const guard = setTimeout(done, 10_000);
	if (map.getSource(overlaySourceId) && map.isSourceLoaded(overlaySourceId)) {
		armPaint();
	} else {
		map.on("sourcedata", onSourceData);
	}
}

/** Tear down the waiting box + its animation marker. Safe to call when nothing is shown, or after the map/style was torn down during navigation. */
export function hideWaitingBox(map: MapboxMap): void {
	pendingShowCorners = null;
	if (animTimer) {
		clearInterval(animTimer);
		animTimer = null;
	}
	animCanvas = null;
	animFrames = [];
	if (!styleReady(map)) return;
	if (map.getLayer(ANIM_LAYER_ID)) map.removeLayer(ANIM_LAYER_ID);
	if (map.getSource(ANIM_SOURCE_ID)) map.removeSource(ANIM_SOURCE_ID);
	if (map.getLayer(BOX_LINE_LAYER_ID)) map.removeLayer(BOX_LINE_LAYER_ID);
	if (map.getLayer(BOX_FILL_LAYER_ID)) map.removeLayer(BOX_FILL_LAYER_ID);
	if (map.getSource(BOX_SOURCE_ID)) map.removeSource(BOX_SOURCE_ID);
}
