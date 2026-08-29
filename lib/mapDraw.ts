import { area, featureCollection, intersect } from "@turf/turf";
import type {
	Feature,
	FeatureCollection,
	LineString,
	MultiPolygon,
	Point,
	Polygon,
} from "geojson";
import type {
	ExpressionSpecification,
	FilterSpecification,
	GeoJSONSource,
	Map as MapboxMap,
} from "mapbox-gl";
import { glyphStack } from "./glyphStack";
import { deriveHandle } from "./labelPlacement";
import { newId } from "./newId";

export type DrawIntent = "polygon" | "line" | "pin" | null;
export type Lnglat = [number, number];

const DRAW_SOURCE_IDS = [
	"draw-edges",
	"draw-vertices",
	"provisional-polygon",
] as const;
const COMPLETED_SOURCE_ID = "completed-features";

export const BOUNDARY_PIN_MAXZOOM = 11;
const CENTROID_SOURCE_ID = "completed-centroids";
const CENTROID_CLUSTER_LAYER = "completed-centroid-cluster";
const CENTROID_CLUSTER_COUNT_LAYER = "completed-centroid-cluster-count";
const CENTROID_PIN_LAYER = "completed-centroid-pin";
const CENTROID_PIN_LABEL_LAYER = "completed-centroid-pin-label";

// POLYGON_OUTLINE is exported as the polygon's default identity colour — areaLabels.ts paints the area-name text with it when a polygon carries no overlap-cycle colour.
const POLYGON_FILL = "#e8a06a";
export const POLYGON_OUTLINE = "#d97c33";
const TRACK_GOLD = "#ffd700";

// Colour cycle order: red, yellow, green, blue, indigo, violet, then red again per stack — a plain sequence, NOT smallest-unused-colour (that made every child overlapping only the parent come out identically red).
const POLYGON_COLOR_CYCLE: ReadonlyArray<{ fill: string; stroke: string }> = [
	{ fill: POLYGON_FILL, stroke: POLYGON_OUTLINE }, // rust — the original
	{ fill: "#cf4444", stroke: "#b82222" }, // red
	{ fill: "#ecd36e", stroke: "#c9a227" }, // yellow
	{ fill: "#8fd48a", stroke: "#3a9e4e" }, // green
	{ fill: "#7db4ec", stroke: "#2f7fd1" }, // blue
	{ fill: "#9c92ea", stroke: "#5a4bc9" }, // indigo
	{ fill: "#d386e8", stroke: "#a33bc9" }, // violet
];

export type RingBbox = [number, number, number, number];

function outerRingBbox(poly: Polygon): RingBbox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of poly.coordinates[0] ?? []) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return [minX, minY, maxX, maxY];
}

function bboxesIntersect(a: RingBbox, b: RingBbox): boolean {
	return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

// Polygon clipping, not booleanOverlap — booleanOverlap flags merely-touching plots as overlapping and wrongly recolours them; the 1m² floor ignores sliver artifacts.
function polygonsShareArea(a: Feature<Polygon>, b: Feature<Polygon>): boolean {
	try {
		const clip = intersect(featureCollection<Polygon>([a, b]));
		return clip !== null && area(clip) > 1;
	} catch {
		return false; // degenerate ring — treat as no overlap
	}
}

// Colour-cycle entry per feature index (absent = default rust). Exported so areaLabels.ts can paint each label in the SAME identity colour these fill/stroke layers use.
export function assignOverlapColors(
	features: Feature[],
): Map<number, { fill: string; stroke: string }> {
	const out = new Map<number, { fill: string; stroke: string }>();
	const placed: {
		feat: Feature<Polygon>;
		bbox: RingBbox;
		/** placed-index of this polygon's stack anchor (a root points at itself). */
		root: number;
	}[] = [];
	// Rainbow colours already handed out per stack, keyed by root index.
	const stackSize = new Map<number, number>();
	for (let i = 0; i < features.length; i++) {
		const feat = features[i];
		if (feat.geometry?.type !== "Polygon") continue;
		const poly = feat as Feature<Polygon>;
		const bbox = outerRingBbox(poly.geometry);
		// Earliest-drawn overlapping polygon decides which stack this one joins (a polygon bridging two stacks joins the older one).
		let root = -1;
		for (let p = 0; p < placed.length; p++) {
			const prev = placed[p];
			if (!bboxesIntersect(bbox, prev.bbox)) continue;
			if (polygonsShareArea(poly, prev.feat)) {
				root = prev.root;
				break;
			}
		}
		if (root === -1) {
			// Overlaps nothing → rust, and anchors a new stack.
			placed.push({ feat: poly, bbox, root: placed.length });
			continue;
		}
		const n = stackSize.get(root) ?? 0;
		stackSize.set(root, n + 1);
		// Slot 0 is rust (the parent's) — children walk slots 1..6 forever.
		const color = 1 + (n % (POLYGON_COLOR_CYCLE.length - 1));
		placed.push({ feat: poly, bbox, root });
		out.set(i, POLYGON_COLOR_CYCLE[color]);
	}
	return out;
}

// Default fill-opacity for a polygon with no per-feature override (the fill-opacity slider UI's resting value).
export const POLYGON_FILL_OPACITY_DEFAULT = 0.3;

// Mapbox doesn't flatten stacked fills — opacity compounds, so stacked children paint thinner (STACKED_FILL_OPACITY) to stay legible; stamped as _stackFillOp by buildCompletedFC.
const STACKED_FILL_OPACITY = 0.15;

// Fill-opacity precedence: per-feature fillOpacity > stacked-child damper > default; to-number guards string values surviving a KML round-trip.
const POLYGON_FILL_OPACITY_EXPR: ExpressionSpecification = [
	"case",
	["has", "fillOpacity"],
	["to-number", ["get", "fillOpacity"], POLYGON_FILL_OPACITY_DEFAULT],
	["has", "_stackFillOp"],
	["to-number", ["get", "_stackFillOp"], POLYGON_FILL_OPACITY_DEFAULT],
	POLYGON_FILL_OPACITY_DEFAULT,
];

// polygonFillFactor is module-level (not component state) so a post-setStyle layer rebuild reapplies the CURRENT slider value, not the default; outlines never fade.
let polygonFillFactor = 1;

function polygonFillOpacityExpr(): ExpressionSpecification {
	if (polygonFillFactor === 1) return POLYGON_FILL_OPACITY_EXPR;
	return ["min", 1, ["*", polygonFillFactor, POLYGON_FILL_OPACITY_EXPR]];
}

// Sets the blanket fill-opacity factor (0–2, centre 1) and pushes it onto the mounted completed-fill layer.
export function applyPolygonFillOpacity(map: MapboxMap, factor: number): void {
	polygonFillFactor = Math.max(0, Math.min(2, factor));
	if (map.getLayer("completed-fill")) {
		map.setPaintProperty(
			"completed-fill",
			"fill-opacity",
			polygonFillOpacityExpr(),
		);
	}
}

function emptyFC(): FeatureCollection {
	return { type: "FeatureCollection", features: [] };
}

export function getAccentColor(fallback = "#b36940"): string {
	if (typeof document === "undefined") return fallback;
	return (
		getComputedStyle(document.documentElement)
			.getPropertyValue("--color-draw")
			.trim() || fallback
	);
}

const VERTEX_HANDLE_LAYERS = [
	"completed-vertices-halo",
	"completed-vertices-dot",
] as const;

// Matches nothing (every real feature's _idx is >= 0) — the default hidden filter; setVertexHandlesForFeature swaps in a real index.
const VERTEX_HANDLES_HIDDEN: FilterSpecification = [
	"all",
	["==", ["geometry-type"], "Point"],
	["==", ["get", "_idx"], -1],
];

// Idempotent — safe to call multiple times on the same map instance.
export function setupDrawSourcesAndLayers(
	map: MapboxMap,
	accent: string,
	/** ⚠️ Pass `false` on any host that doesn't draw geometry through THIS module (e.g. mobile, owned by SnakeRuler) — avoids wasted sources/GPU layers; kept true because rapper desktop draws through them. */
	withInProgress = true,
): void {
	// Guard keys off completed-features (created by every host) — keying off the now-optional draw-edges would re-add layers on mobile and throw "Layer already exists".
	if (map.getSource("completed-features")) return;

	const empty = emptyFC();

	// In-progress drawing — only for hosts that actually draw through this module. See withInProgress above.
	if (withInProgress) {
		map.addSource("draw-edges", { type: "geojson", data: empty });
		map.addSource("draw-vertices", { type: "geojson", data: empty });
		map.addSource("provisional-polygon", { type: "geojson", data: empty });

		map.addLayer({
			id: "draw-edges-halo",
			type: "line",
			source: "draw-edges",
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": "#1a1a1a",
				"line-width": 6,
				"line-opacity": 0.55,
			},
		});
		map.addLayer({
			id: "draw-edges-line",
			type: "line",
			source: "draw-edges",
			layout: { "line-cap": "round", "line-join": "round" },
			paint: { "line-color": accent, "line-width": 4 },
		});
		map.addLayer({
			id: "provisional-polygon-fill",
			type: "fill",
			source: "provisional-polygon",
			filter: ["==", "$type", "Polygon"],
			paint: { "fill-color": POLYGON_FILL, "fill-opacity": 0.35 },
		});
		map.addLayer({
			id: "provisional-polygon-closing-edge",
			type: "line",
			source: "provisional-polygon",
			filter: ["==", "$type", "LineString"],
			// provisional-polygon only ever holds polygon geometry, so this closing edge is always a polygon's — colour it orange.
			paint: {
				"line-color": POLYGON_OUTLINE,
				"line-width": 2.5,
				"line-dasharray": [6, 4],
			},
		});
		map.addLayer({
			id: "draw-vertices-halo",
			type: "circle",
			source: "draw-vertices",
			paint: { "circle-radius": 7, "circle-color": "#ffffff" },
		});
		map.addLayer({
			id: "draw-vertices-dot",
			type: "circle",
			source: "draw-vertices",
			paint: { "circle-radius": 4, "circle-color": accent },
		});
	} // end withInProgress

	// Completed features are ALWAYS created — the user's saved shapes are visible on a cold map with no interaction.
	map.addSource(COMPLETED_SOURCE_ID, { type: "geojson", data: empty });

	map.addLayer({
		id: "completed-fill",
		type: "fill",
		source: COMPLETED_SOURCE_ID,
		filter: ["==", "$type", "Polygon"],
		// _fillCol is the overlap-cycle colour stamped by buildCompletedFC; polygons that overlap nothing carry none and fall back to rust.
		paint: {
			"fill-color": ["coalesce", ["get", "_fillCol"], POLYGON_FILL],
			"fill-opacity": polygonFillOpacityExpr(),
		},
	});
	// Area-name labels render as DOM markers (areaLabels.ts), not a symbol layer — GL text can't do the needed font/halo/wrap-width.
	map.addLayer({
		id: "completed-stroke-halo",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": "#1a1a1a",
			"line-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				3,
				["==", ["geometry-type"], "Polygon"],
				5,
				5.5,
			],
			"line-gap-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				1.5,
				0,
			],
			"line-opacity": 0.5,
		},
	});
	map.addLayer({
		id: "completed-stroke",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		layout: { "line-cap": "round", "line-join": "round" },
		paint: {
			"line-color": [
				"case",
				["==", ["get", "featureType"], "track"],
				TRACK_GOLD,
				["==", ["geometry-type"], "Polygon"],
				["coalesce", ["get", "_strokeCol"], POLYGON_OUTLINE],
				accent,
			],
			"line-width": [
				"case",
				["==", ["get", "featureType"], "track"],
				1.5,
				["==", ["geometry-type"], "Polygon"],
				2.5,
				3,
			],
			"line-gap-width": ["case", ["==", ["get", "featureType"], "track"], 3, 0],
		},
	});
	map.addLayer({
		id: "completed-track-ties",
		type: "line",
		source: COMPLETED_SOURCE_ID,
		filter: [
			"all",
			["==", ["get", "featureType"], "track"],
			["==", ["geometry-type"], "LineString"],
		],
		layout: { "line-cap": "butt", "line-join": "round" },
		paint: {
			"line-color": TRACK_GOLD,
			"line-width": 9,
			"line-dasharray": [0.12, 1.6],
		},
	});
	// Vertex handles are an editing affordance, start hidden, revealed per-feature via setVertexHandlesForFeature; pins are NOT in this source — they render as DOM markers (mapboxgl.Marker) with native click handling.
	map.addLayer({
		id: "completed-vertices-halo",
		type: "circle",
		source: COMPLETED_SOURCE_ID,
		filter: VERTEX_HANDLES_HIDDEN,
		// TRACK vertices carry no halo — breadcrumbs, not editing handles; a white ring on every GPS point would read as clutter.
		paint: {
			"circle-radius": ["case", ["==", ["get", "_isTrack"], true], 0, 7],
			"circle-color": "#ffffff",
		},
	});
	map.addLayer({
		id: "completed-vertices-dot",
		type: "circle",
		source: COMPLETED_SOURCE_ID,
		filter: VERTEX_HANDLES_HIDDEN,
		// Vertex dot colour matches its parent shape via _parentType (stamped by buildCompletedFC); track breadcrumbs are bigger (no halo) for texture.
		paint: {
			"circle-radius": ["case", ["==", ["get", "_isTrack"], true], 5.5, 4],
			"circle-color": [
				"case",
				["==", ["get", "_isTrack"], true],
				TRACK_GOLD,
				["==", ["get", "_parentType"], "Polygon"],
				["coalesce", ["get", "_strokeCol"], POLYGON_OUTLINE],
				accent,
			],
		},
	});

	// Boundary pins: clustered polygon centroids for far-out zooms — consumer must push data via buildCentroidFC alongside completed-features.
	map.addSource(CENTROID_SOURCE_ID, {
		type: "geojson",
		data: empty,
		cluster: true,
		clusterMaxZoom: BOUNDARY_PIN_MAXZOOM,
		clusterRadius: 40,
	});
	map.addLayer({
		id: CENTROID_CLUSTER_LAYER,
		type: "circle",
		source: CENTROID_SOURCE_ID,
		filter: ["has", "point_count"],
		maxzoom: BOUNDARY_PIN_MAXZOOM,
		paint: {
			"circle-color": POLYGON_OUTLINE,
			"circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
			"circle-stroke-width": 2,
			"circle-stroke-color": "#ffffff",
		},
	});
	map.addLayer({
		id: CENTROID_CLUSTER_COUNT_LAYER,
		type: "symbol",
		source: CENTROID_SOURCE_ID,
		filter: ["has", "point_count"],
		maxzoom: BOUNDARY_PIN_MAXZOOM,
		layout: {
			"text-field": ["get", "point_count_abbreviated"],
			// Font must come from the LIVE style via glyphStack(map) — a literal stack here 404s forever on whichever map it wasn't written for.
			"text-font": glyphStack(map),
			"text-size": 13,
			"text-allow-overlap": true,
		},
		paint: { "text-color": "#3a2410" },
	});
	map.addLayer({
		id: CENTROID_PIN_LAYER,
		type: "circle",
		source: CENTROID_SOURCE_ID,
		filter: ["!", ["has", "point_count"]],
		maxzoom: BOUNDARY_PIN_MAXZOOM,
		paint: {
			"circle-color": POLYGON_OUTLINE,
			"circle-radius": 7,
			"circle-stroke-width": 2,
			"circle-stroke-color": "#ffffff",
		},
	});
	// Solo pin shows its polygon's NAME underneath — never hectares (those live in the AREA popover on tap, not on the map).
	map.addLayer({
		id: CENTROID_PIN_LABEL_LAYER,
		type: "symbol",
		source: CENTROID_SOURCE_ID,
		filter: ["all", ["!", ["has", "point_count"]], ["has", "_nameLabel"]],
		maxzoom: BOUNDARY_PIN_MAXZOOM,
		layout: {
			"text-field": ["get", "_nameLabel"],
			// ⛔ NEVER hardcode a text-font stack (see glyphStack.ts) — hosted style has DIN/Arial with no Noto, offline base has only Noto; a literal array 404s forever on one or the other and floods the console.
			"text-font": glyphStack(map),
			"text-size": 11,
			"text-anchor": "top",
			"text-offset": [0, 1.1],
		},
		paint: {
			"text-color": "#3a2410",
			"text-halo-color": "#ffe9c2",
			"text-halo-width": 1.6,
		},
	});
}

// idx = the feature's _idx; pass null to hide every handle. Edit-state ownership stays in the consumer — this only maps an index onto the two GL layer filters.
export function setVertexHandlesForFeature(
	map: MapboxMap,
	idx: number | null,
): void {
	const filter: FilterSpecification =
		idx === null
			? VERTEX_HANDLES_HIDDEN
			: [
					"all",
					["==", ["geometry-type"], "Point"],
					["==", ["get", "_idx"], idx],
				];
	for (const id of VERTEX_HANDLE_LAYERS) {
		if (map.getLayer(id)) map.setFilter(id, filter);
	}
}

// Geo bbox of a (Multi)Polygon's outer ring(s) — exported for areaLabels.ts, which anchors labels at the same bbox centre buildCentroidFC uses for boundary pins.
export function geometryBbox(g: Polygon | MultiPolygon): RingBbox | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
	for (const poly of polys) {
		for (const [x, y] of poly[0] ?? []) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (!Number.isFinite(minX)) return null;
	return [minX, minY, maxX, maxY];
}

// Consumers must push this alongside buildCompletedFC from the SAME feature array, so pins obey the same visibility toggles as their shapes; _bbox rides along so a pin tap can frame its polygon.
export function buildCentroidFC(features: Feature[]): FeatureCollection {
	const out: Feature[] = [];
	for (const feat of features) {
		const g = feat.geometry;
		if (g?.type !== "Polygon" && g?.type !== "MultiPolygon") continue;
		const bbox = geometryBbox(g);
		if (!bbox) continue;
		// Solo-pin caption is the SHORT HANDLE, never the raw paragraph; unnamed polygons get a bare pin (has _nameLabel filter skips them); truncated names get a trailing "…".
		const fullName = String(feat.properties?.name ?? "").trim();
		const rawHandle =
			String(feat.properties?.displayName ?? "").trim() ||
			(fullName === "" ? "" : deriveHandle(fullName));
		const name =
			rawHandle !== "" && rawHandle !== fullName ? `${rawHandle}…` : rawHandle;
		out.push({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
			},
			properties: {
				...(name === "" ? {} : { _nameLabel: name }),
				_bbox: bbox,
			},
		});
	}
	return { type: "FeatureCollection", features: out };
}

// _bbox comes back JSON-stringified from queryRenderedFeatures (GL serializes non-scalar properties) — parse + finite-check it.
function parseBbox(raw: unknown): RingBbox | null {
	let arr: unknown = raw;
	if (typeof raw === "string") {
		try {
			arr = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	return Array.isArray(arr) &&
		arr.length === 4 &&
		arr.every((n) => Number.isFinite(n))
		? (arr as RingBbox)
		: null;
}

// EXCLUSIVE tap target (same contract as grid dots) — a hit here must NOT also select the sub-pixel polygon underneath via the generic click hit-test.
export function boundaryPinAt(
	map: MapboxMap,
	point: { x: number; y: number },
): boolean {
	const layers = [CENTROID_CLUSTER_LAYER, CENTROID_PIN_LAYER].filter((l) =>
		map.getLayer(l),
	);
	if (layers.length === 0) return false;
	return map.queryRenderedFeatures([point.x, point.y], { layers }).length > 0;
}

const boundaryPinWired = new WeakSet<MapboxMap>();

// Wires listeners once per map instance (survives setStyle, guarded so repeat setup is a no-op); isNavigationAllowed lets a draw tool veto navigation so a vertex tap never also flies the camera.
export function wireBoundaryPinNavigation(
	map: MapboxMap,
	isNavigationAllowed: () => boolean = () => true,
): void {
	if (boundaryPinWired.has(map)) return;
	boundaryPinWired.add(map);

	map.on("click", CENTROID_CLUSTER_LAYER, (e) => {
		if (!isNavigationAllowed()) return;
		const f = map.queryRenderedFeatures(e.point, {
			layers: [CENTROID_CLUSTER_LAYER],
		})[0];
		const clusterId = f?.properties?.cluster_id as number | undefined;
		const src = map.getSource(CENTROID_SOURCE_ID) as GeoJSONSource | undefined;
		if (clusterId == null || !src) return;
		src.getClusterExpansionZoom(clusterId, (err, zoom) => {
			if (err || zoom == null) return;
			const center = (f.geometry as Point).coordinates;
			if (!center.every((n) => Number.isFinite(n))) return;
			map.easeTo({ center: center as Lnglat, zoom });
		});
	});
	map.on("click", CENTROID_PIN_LAYER, (e) => {
		if (!isNavigationAllowed()) return;
		const f = map.queryRenderedFeatures(e.point, {
			layers: [CENTROID_PIN_LAYER],
		})[0];
		const bbox = parseBbox(f?.properties?._bbox);
		if (!bbox) return;
		map.fitBounds(
			[
				[bbox[0], bbox[1]],
				[bbox[2], bbox[3]],
			],
			{ padding: 80, maxZoom: 15, duration: 700 },
		);
	});
	for (const layer of [CENTROID_CLUSTER_LAYER, CENTROID_PIN_LAYER]) {
		map.on("mouseenter", layer, () => {
			map.getCanvas().style.cursor = "pointer";
		});
		map.on("mouseleave", layer, () => {
			map.getCanvas().style.cursor = "";
		});
	}
}

export function buildDrawEdgesFC(vertices: Lnglat[]): FeatureCollection {
	if (vertices.length < 2) return emptyFC();
	return {
		type: "FeatureCollection",
		features: [
			{
				type: "Feature",
				geometry: { type: "LineString", coordinates: vertices },
				properties: {},
			},
		],
	};
}

export function buildDrawVerticesFC(vertices: Lnglat[]): FeatureCollection {
	return {
		type: "FeatureCollection",
		features: vertices.map((coord) => ({
			type: "Feature" as const,
			geometry: { type: "Point" as const, coordinates: coord },
			properties: {},
		})),
	};
}

export function buildProvisionalPolygonFC(
	vertices: Lnglat[],
	intent: DrawIntent,
): FeatureCollection {
	if (intent !== "polygon" || vertices.length < 2) return emptyFC();

	const ring = [...vertices, vertices[0]];
	const closingEdge = [vertices[vertices.length - 1], vertices[0]];

	const features: Feature[] = [
		{
			type: "Feature",
			geometry: { type: "LineString", coordinates: closingEdge },
			properties: {},
		},
	];
	if (vertices.length >= 3) {
		features.push({
			type: "Feature",
			geometry: { type: "Polygon", coordinates: [ring] },
			properties: {},
		});
	}
	return { type: "FeatureCollection", features };
}

// Pins (Point geometries) are intentionally EXCLUDED — rendered as DOM markers by the consumer, not a symbol layer; polygons, lines, and synthesized vertex Points stay here.
export function buildCompletedFC(features: Feature[]): FeatureCollection {
	const out: Feature[] = [];
	// Display-only — stamped onto FC copies, never onto stored features, so colour re-derives from live geometry on every rebuild (draw, drag, delete).
	const overlapColors = assignOverlapColors(features);
	for (let i = 0; i < features.length; i++) {
		const feat = features[i];
		if (feat.geometry?.type === "Point") continue; // pins → DOM markers
		// Area-name labels are DOM markers too (areaLabels.ts) — nothing label-related rides on the FC.
		const overlapColor = overlapColors.get(i);
		out.push({
			...feat,
			properties: {
				...(feat.properties ?? {}),
				_idx: i,
				...(overlapColor
					? {
							_fillCol: overlapColor.fill,
							_strokeCol: overlapColor.stroke,
							_stackFillOp: STACKED_FILL_OPACITY,
						}
					: {}),
			},
		});

		if (feat.geometry?.type === "Polygon") {
			const ring = (feat.geometry as Polygon).coordinates[0];
			// Skip the closing-duplicate vertex (last === first) so we don't emit two overlapping draggable points at vertex 0.
			const last = ring.length - 1;
			const closes =
				ring.length > 1 &&
				ring[0][0] === ring[last][0] &&
				ring[0][1] === ring[last][1];
			const stop = closes ? last : ring.length;
			for (let v = 0; v < stop; v++) {
				out.push({
					type: "Feature",
					geometry: {
						type: "Point",
						coordinates: ring[v],
					} as Point,
					properties: {
						_idx: i,
						_vertexIdx: v,
						_isEndpoint: false,
						_parentType: "Polygon",
						...(overlapColor ? { _strokeCol: overlapColor.stroke } : {}),
					},
				});
			}
		} else if (feat.geometry?.type === "LineString") {
			const coords = (feat.geometry as LineString).coordinates;
			// A recorded TRACK's vertices are breadcrumbs, not editing handles — plain accent balls (no halo) for texture; stamped so vertex layers can style them apart from drawn lines.
			const isTrack = feat.properties?.featureType === "track";
			for (let v = 0; v < coords.length; v++) {
				const coord = coords[v];
				const isEndpoint = v === 0 || v === coords.length - 1;
				out.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: coord } as Point,
					properties: {
						_idx: i,
						_vertexIdx: v,
						_isEndpoint: isEndpoint,
						_parentType: "LineString",
						...(isTrack ? { _isTrack: true } : {}),
					},
				});
			}
		}
	}
	return { type: "FeatureCollection", features: out };
}

export interface PixelBbox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// Returns null if coords is empty.
export function projectLnglatBbox(
	map: MapboxMap,
	coords: ReadonlyArray<Lnglat | number[]>,
): PixelBbox | null {
	if (coords.length === 0) return null;
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const c of coords) {
		const pt = map.project({ lng: c[0], lat: c[1] });
		if (pt.x < minX) minX = pt.x;
		if (pt.x > maxX) maxX = pt.x;
		if (pt.y < minY) minY = pt.y;
		if (pt.y > maxY) maxY = pt.y;
	}
	return { minX, minY, maxX, maxY };
}

/** Screen-space bbox of a completed feature's geometry. */
export function projectFeatureBbox(
	map: MapboxMap,
	feature: Feature,
): PixelBbox | null {
	if (!feature.geometry) return null;
	let coords: number[][] = [];
	if (feature.geometry.type === "Polygon") {
		coords = (feature.geometry as Polygon).coordinates[0];
	} else if (feature.geometry.type === "LineString") {
		coords = (feature.geometry as LineString).coordinates;
	} else if (feature.geometry.type === "Point") {
		coords = [(feature.geometry as Point).coordinates];
	}
	return projectLnglatBbox(map, coords);
}

// Pins are NOT in this set (DOM markers own their own clicks); tolerancePx defaults to 12px because thin (~3px) lines are unhittable at single-tap precision on a phone.
export function hitTestCompleted(
	map: MapboxMap,
	point: { x: number; y: number },
	tolerancePx = 12,
): number | null {
	const layers = [
		"completed-fill",
		"completed-stroke",
		"completed-vertices-halo",
		"completed-vertices-dot",
	];
	const r = Math.max(0, tolerancePx);
	const bbox: [[number, number], [number, number]] = [
		[point.x - r, point.y - r],
		[point.x + r, point.y + r],
	];
	const hits = map.queryRenderedFeatures(bbox, { layers });
	if (hits.length === 0) return null;
	const idx = hits[0].properties?._idx;
	return typeof idx === "number" ? idx : null;
}

// Resets the three in-progress drawing sources to empty FCs — does not touch completed-features.
export function clearInProgressSources(map: MapboxMap): void {
	const empty = emptyFC();
	for (const id of DRAW_SOURCE_IDS) {
		const src = map.getSource(id);
		if (src && "setData" in src) {
			(src as unknown as { setData: (d: FeatureCollection) => void }).setData(
				empty,
			);
		}
	}
}

// properties.name is left empty on purpose — the proprietary mobile layer supplies the canonical default name; don't fill it here, rapper is naming-convention-agnostic.
export function finalizeFeature(
	intent: Exclude<DrawIntent, null>,
	vertices: Lnglat[],
): Feature {
	const id = newId();
	if (intent === "polygon") {
		const ring = [...vertices, vertices[0]];
		return {
			type: "Feature",
			id,
			geometry: { type: "Polygon", coordinates: [ring] },
			properties: { name: "", notes: "" },
		};
	}
	if (intent === "pin") {
		return {
			type: "Feature",
			id,
			geometry: { type: "Point", coordinates: vertices[0] },
			properties: { name: "", notes: "" },
		};
	}
	return {
		type: "Feature",
		id,
		geometry: { type: "LineString", coordinates: [...vertices] },
		properties: { name: "", notes: "" },
	};
}
