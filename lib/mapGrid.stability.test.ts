// THE LAW: updateGrid draws the same dot at the same ground coordinate with the same code regardless of viewport — a dot that hops a cell (~14m) between pans is lying about the ground.

import { describe, expect, it } from "vitest";
import type { FeatureCollection, Point } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import { nearestGridDot, setupGridSourcesAndLayers, updateGrid } from "./mapGrid.js";

function mockMap(sw: { lat: number; lng: number }, ne: { lat: number; lng: number }) {
	const sources = new Map<string, { setData: (d: FeatureCollection) => void }>();
	const captured = new Map<string, FeatureCollection>();
	const map = {
		getZoom: () => 15,
		getBounds: () => ({ getSouthWest: () => sw, getNorthEast: () => ne }),
		addSource: (id: string) => {
			sources.set(id, { setData: (d) => captured.set(id, d) });
		},
		getSource: (id: string) => sources.get(id),
		addLayer: () => {
			/* layers are irrelevant here — only source data is asserted */
		},
		getLayer: () => undefined,
	};
	return { map: map as unknown as MapboxMap, captured };
}

function drawnHectares(
	sw: { lat: number; lng: number },
	ne: { lat: number; lng: number },
	mode: "standard" | "fine" = "standard",
) {
	const { map, captured } = mockMap(sw, ne);
	setupGridSourcesAndLayers(map);
	const r = updateGrid(map, mode);
	expect(r.tooDense).toBe(false);
	const fc = captured.get("audit-grid-hectare");
	const dots = new Map<string, string>();
	for (const f of fc?.features ?? []) {
		const [lng, lat] = (f.geometry as Point).coordinates;
		dots.set(`${lat.toFixed(9)},${lng.toFixed(9)}`, String(f.properties?.plusCode));
	}
	return dots;
}

function inBox(
	dots: Map<string, string>,
	box: { latLo: number; latHi: number; lngLo: number; lngHi: number },
) {
	const out = new Map<string, string>();
	for (const [k, code] of dots) {
		const [lat, lng] = k.split(",").map(Number);
		if (lat >= box.latLo && lat <= box.latHi && lng >= box.lngLo && lng <= box.lngHi) {
			out.set(k, code);
		}
	}
	return out;
}

describe("the drawn grid is identical for every viewport covering the same ground", () => {
	const SPOTS = [
		{ lat: 45.42, lng: -75.69 },
		{ lat: 50.41, lng: -119.24 },
	];
	// Offsets must stay small enough that the shifted viewport still contains the comparison box (margin: 0.0098°).
	const OFFSETS = [
		0, 0.0013177, -0.0027421, 0.0041893, -0.0006219, 0.0072371, -0.0084731,
		0.0002083, -0.0048999, 0.0061113,
	];

	for (const spot of SPOTS) {
		it(`hectare dots never move or change code near ${spot.lat},${spot.lng}`, () => {
			const box = {
				latLo: spot.lat - 0.0022,
				latHi: spot.lat + 0.0022,
				lngLo: spot.lng - 0.0033,
				lngHi: spot.lng + 0.0033,
			};
			let reference: Map<string, string> | null = null;
			for (const dLat of OFFSETS) {
				for (const dLng of [0, 0.0035471, -0.0058313]) {
					const sw = { lat: spot.lat - 0.012 + dLat, lng: spot.lng - 0.018 + dLng };
					const ne = { lat: spot.lat + 0.012 + dLat, lng: spot.lng + 0.018 + dLng };
					const dots = inBox(drawnHectares(sw, ne), box);
					expect(dots.size).toBeGreaterThan(6);
					if (!reference) {
						reference = dots;
						continue;
					}
					// Same ground → same dots, coordinate-identical AND code-identical.
					expect([...dots.keys()].sort()).toEqual([...reference.keys()].sort());
					for (const [k, code] of dots) expect(code).toBe(reference.get(k));
				}
			}
		});
	}

	it("fine dots never move or change code either", () => {
		const spot = SPOTS[1];
		const box = {
			latLo: spot.lat - 0.0011,
			latHi: spot.lat + 0.0011,
			lngLo: spot.lng - 0.0016,
			lngHi: spot.lng + 0.0016,
		};
		let reference: Map<string, string> | null = null;
		for (const dLat of [0, 0.0013177, -0.0027421, 0.0024893]) {
			const sw = { lat: spot.lat - 0.004 + dLat, lng: spot.lng - 0.0045 };
			const ne = { lat: spot.lat + 0.004 + dLat, lng: spot.lng + 0.0045 };
			const { map, captured } = mockMap(sw, ne);
			setupGridSourcesAndLayers(map);
			updateGrid(map, "fine");
			const dots = new Map<string, string>();
			for (const src of ["audit-grid-hectare", "audit-grid-fine"]) {
				for (const f of captured.get(src)?.features ?? []) {
					const [lng, lat] = (f.geometry as Point).coordinates;
					dots.set(`${lat.toFixed(9)},${lng.toFixed(9)}`, String(f.properties?.plusCode));
				}
			}
			const boxed = inBox(dots, box);
			expect(boxed.size).toBeGreaterThan(10);
			if (!reference) {
				reference = boxed;
				continue;
			}
			expect([...boxed.keys()].sort()).toEqual([...reference.keys()].sort());
			for (const [k, code] of boxed) expect(code).toBe(reference.get(k));
		}
	});
});

describe("E-W spacing is a property of the GROUND, not the camera's centre latitude", () => {
	// E-W spacing must be a property of the ground, not viewport centre latitude — two viewports whose centres straddle the ~46.84° 10↔11-cell threshold must still agree on the shared band.
	it("dots in the shared band match across the 10↔11-cell threshold", () => {
		const band = { latLo: 46.828, latHi: 46.844, lngLo: -119.257, lngHi: -119.235 };
		const below = drawnHectares(
			{ lat: 46.76, lng: -119.27 },
			{ lat: 46.85, lng: -119.22 },
		);
		const above = drawnHectares(
			{ lat: 46.826, lng: -119.27 },
			{ lat: 46.92, lng: -119.22 },
		);
		const a = inBox(below, band);
		const b = inBox(above, band);
		expect(a.size).toBeGreaterThan(6);
		expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
		for (const [k, code] of a) expect(code).toBe(b.get(k));
	});
});

describe("draw and tap agree — every drawn dot snaps to itself", () => {
	// nearestGridDot (tap path) and updateGrid (draw path) must mint the same lattice, or a tap lands where no dot is drawn.
	it("every drawn hectare dot round-trips through nearestGridDot", () => {
		for (const spot of [
			{ lat: 45.42, lng: -75.69 },
			{ lat: 50.41, lng: -119.24 },
			{ lat: 46.836, lng: -119.24 }, // the threshold band
		]) {
			const dots = drawnHectares(
				{ lat: spot.lat - 0.004, lng: spot.lng - 0.006 },
				{ lat: spot.lat + 0.004, lng: spot.lng + 0.006 },
			);
			expect(dots.size).toBeGreaterThan(6);
			for (const [k, code] of dots) {
				const [lat, lng] = k.split(",").map(Number);
				const snapped = nearestGridDot(lng, lat, "standard", 30);
				expect(snapped, `no snap at drawn dot ${code}`).not.toBeNull();
				expect(snapped?.plusCode, `tap/draw disagree at ${k}`).toBe(code);
				expect(Math.abs((snapped?.lat ?? 0) - lat)).toBeLessThan(1e-9);
				expect(Math.abs((snapped?.lng ?? 0) - lng)).toBeLessThan(1e-9);
			}
		}
	});
});
