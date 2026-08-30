<script lang="ts">
import { onMount } from "svelte";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/stores";
import "mapbox-gl/dist/mapbox-gl.css";
// THE CHILD CARRIES ITS OWN STYLESHEET.
//
// map.css used to be pulled in ONLY by each parent's app.css, as
// `@import '../../getCache_OnlineMap/lib/map.css'` — a raw climb from the
// parent sideways INTO this child. That is backwards: children reach up to a
// parent through $parent, parents do not reach down into children by name. It
// also made the parent unbuildable without this child on disk, which is what
// broke a one-child install of rapper.
//
// Same lesson as the comment on .viewport-layout below, which moved three
// rules in here for the same reason: "A child must not need a global
// stylesheet the host might not have." This finishes that job for the rest of
// the file, and the parent-side @import is deleted rather than left as a
// second, silent copy.
//
// Vite injects this at runtime, AFTER the parent's app.css. Safe here because
// every rule this adds is UNLAYERED while the mapbox/maplibre vendor CSS is
// demoted into `layer(vendor)` — and an unlayered rule beats a layered one
// regardless of source order. Cf. getCache_OfflineMap's maplibreVendor.css,
// which relies on exactly the same ordering.
import "./map.css";
import InfoPanel from "./mapInfoPanel.svelte";
import MapNavButtons from "./mapNavButtons.svelte";
import { fullMapOptions, initializeMap } from "./mapInit";
import { safeEase } from "./safeEase";
import { toCoordFromArray, type Coord } from "./coord";
import { addOrgMarkersLayer } from "./mapLayerOrg";
import MapDrawControls from "./mapDrawControls.svelte";
import PanelLand from "./mapPanelLand.svelte";
import PanelOrg from "./mapPanelOrg.svelte";
// The dev-tray hand-off. Same action the offline map uses, from the same
// shared seam as the EphemeralCard it portals into (`$rig/…` —
// the one folder every tier reads). Names no tier.
import { portal } from "$rig/dev/portal";

// Block browser page zoom from trackpad pinch gestures.
// Without this, pinching anywhere on the page (including over overlays) zooms
// the entire browser page instead of the map.
function blockBrowserZoom() {
    const blockWheel = (e: WheelEvent) => {
        // ctrlKey is set during trackpad pinch-to-zoom on macOS
        if (e.ctrlKey) e.preventDefault();
    };
    const blockGesture = (e: Event) => e.preventDefault();

    document.addEventListener("wheel", blockWheel, {
        capture: true,
        passive: false,
    });
    document.addEventListener("gesturestart", blockGesture, {
        capture: true,
        passive: false,
    });
    document.addEventListener("gesturechange", blockGesture, {
        capture: true,
        passive: false,
    });
    document.addEventListener("gestureend", blockGesture, {
        capture: true,
        passive: false,
    });

    return () => {
        document.removeEventListener("wheel", blockWheel, { capture: true });
        document.removeEventListener("gesturestart", blockGesture, {
            capture: true,
        });
        document.removeEventListener("gesturechange", blockGesture, {
            capture: true,
        });
        document.removeEventListener("gestureend", blockGesture, {
            capture: true,
        });
    };
}

// ─── OVERRIDE PATTERN ───────────────────────────────────────────────────────
// rapper defaults to its own assets. ReTreever (or any consumer) passes props
// to swap them. To add a new overrideable asset, add an `export let` here.
//
// Where these props are passed in from:
//   ReTreever:  src/routes/where/+page.svelte      →  <MapPage markerUrl="..." />
//   ReTreever:  src/routes/who/map/+page.svelte    →  <MapPage variant="org" />
// ────────────────────────────────────────────────────────────────────────────
export let markerUrl: string | undefined = undefined;
export let variant: "land" | "org" = "land";
/**
 * WHERE THE DATA COMES FROM — full URLs, supplied by the CONSUMER.
 *
 * This component used to `import { PUBLIC_API_URL } from "$env/static/public"`
 * and build `${PUBLIC_API_URL}/api/where/polygons` itself. Two problems, both
 * fatal to a published package: `$env/static/public` is a SvelteKit VIRTUAL
 * module that cannot resolve from node_modules (the build fails outright), and
 * the route names are ReTreever's, so nobody else's backend answers them.
 *
 * Defaults are same-origin relative paths, which is what a plain SvelteKit app
 * serving its own API wants. ReTreever passes absolute URLs. See RULE 7 in
 * childBoundary.test.ts.
 */
export let polygonsUrl = "/polygons";
export let organizationsUrl = "/organizations";
// Draw-tool persistence hooks — threaded straight through to
// MapDrawControls (mapDrawControls.svelte). rapper never stores drawings itself;
// the consumer persists finished features and hands them back on load.
export let onFeatureComplete:
    | ((feature: import("geojson").Feature) => void)
    | undefined = undefined;
export let initialFeatures: import("geojson").Feature[] | undefined =
    undefined;
/**
 * WHERE THE DEV CHROME GOES — the same hand-off the offline map has.
 *
 * This page's only dev chrome is the read-out below (variant, camera, the
 * selected feature). Its DATA is this component's, so it stays owned here;
 * its PLACE is the host's. A page hands in an element — the content box of an
 * EphemeralCard from `$rig/dev` — and
 * the node is moved into it, state and scoped styles intact. Absent, it sits
 * over the map, which is what a standalone checkout gets. Either way it is
 * `import.meta.env.DEV` only and never reaches a build.
 *
 * No rail hosts: unlike the offline map this page has no instrument rails to
 * dock, so it takes only the tray.
 */
export let debugHost: HTMLElement | undefined = undefined;
// Fires once the style has loaded (initializeMap's own onMapReady) — the hook
// consumers use to add their own sources/layers, e.g. ReTreever's store pins.
export let onMapReady: ((map: import("mapbox-gl").Map) => void) | undefined =
    undefined;
const dev = import.meta.env.DEV;
/** The read-out's text. Written from `moveend`, so one line per gesture. */
let devCamera = "";

let mapContainer: HTMLDivElement;
let selectedFeature: any = null;
let splashVisible = true;

// These two may resolve in either order — coordinate with pendingFeature
let mapInstance: import("mapbox-gl").Map | null = null;
let pendingFeature: any = null;

function flyToAndSelect(map: import("mapbox-gl").Map, feature: any) {
    selectedFeature = feature;
    // centroid may be parsed object or JSON string (Mapbox serializes properties).
    // Org features carry geometry.coordinates directly. toCoordFromArray
    // rejects NaN/Infinity/out-of-range at this boundary so downstream
    // safeEase never sees a bad value.
    let raw: unknown = null;
    if (feature?.geometry?.coordinates) {
        raw = feature.geometry.coordinates;
    } else if (feature?.centroid?.coordinates) {
        raw = feature.centroid.coordinates;
    } else if (typeof feature?.centroid === "string") {
        try {
            raw = JSON.parse(feature.centroid)?.coordinates ?? null;
            // codestyle-allow-swallow: a malformed centroid string just leaves raw null; toCoordFromArray(null) handles it and the ease is skipped
        } catch {}
    }
    const coords: Coord | null = toCoordFromArray(raw);
    if (coords) {
        safeEase(map, {
            center: coords,
            zoom: variant === "org" ? 10 : 14,
            duration: 1200,
        });
    }
}

onMount(() => {
    const isOrg = variant === "org";
    const paramName = isOrg ? "org" : "land";
    const redirectPath = isOrg ? "/who/map" : "/where";

    const landParam = isOrg ? null : $page.url.searchParams.get("land");
    const projectNameParam = isOrg
        ? null
        : $page.url.searchParams.get("projectName");
    const orgParam = isOrg ? $page.url.searchParams.get("org") : null;
    const hasTarget = !!(landParam || projectNameParam || orgParam);

    fullMapOptions.autoRotate = !hasTarget;

    const isMobile = window.innerWidth < 768;

    const handleFeatureSelect = (feature: any) => {
        selectedFeature = feature;
        const key = isOrg ? feature?.organizationKey : feature?.landKey;
        if (key) {
            goto(`${redirectPath}?${paramName}=${encodeURIComponent(key)}`, {
                replaceState: true,
                noScroll: true,
            });
        }
    };

    const cleanup = initializeMap(mapContainer, {
        ...fullMapOptions,
        enableHash: !isOrg,
        // Through the router, not raw history — see mapUtilsHash.
        writeHash: (url: string) => replaceState(url, {}),
        // Org view disables polygon marker loading; org markers come from addOrgMarkersLayer below.
        ...(isOrg && { loadMarkers: false }),
        ...(isMobile && { showDrawTools: false, initialZoom: 3.5 }),
        polygonsUrl,
        organizationsUrl,
        ...(markerUrl && { markerUrl }),
        onFeatureSelect: handleFeatureSelect,
        onMapReady: async (map) => {
            mapInstance = map;

            if (dev) {
                const writeCamera = () => {
                    const c = map.getCenter();
                    devCamera = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)} · z${map.getZoom().toFixed(2)}`;
                };
                writeCamera();
                map.on("moveend", writeCamera);
            }

            if (isOrg) {
                await addOrgMarkersLayer(map, {
                    organizationsUrl,
                    onFeatureSelect: handleFeatureSelect,
                });
            } else {
                // Splash is land-view only.
                map.once("idle", () => {
                    splashVisible = false;
                });
                setTimeout(() => {
                    splashVisible = false;
                }, 3000);
            }

            if (pendingFeature) {
                flyToAndSelect(map, pendingFeature);
                pendingFeature = null;
            }

            onMapReady?.(map);
        },
    });

    // Fetch target feature in parallel with map load
    if (hasTarget) {
        (async () => {
            try {
                const withQuery = (u: string, q: string) =>
                    `${u}${u.includes("?") ? "&" : "?"}${q}`;
                const apiUrl = isOrg
                    ? withQuery(organizationsUrl, "format=geojson")
                    : withQuery(polygonsUrl, "mode=centroids");
                const response = await fetch(apiUrl);
                if (!response.ok) return;

                const data = await response.json();
                let targetFeature: any = null;

                if (isOrg && orgParam) {
                    const match = data.features?.find(
                        (f: any) =>
                            f.id === orgParam ||
                            f.properties?.organizationKey === orgParam,
                    );
                    if (match) {
                        targetFeature = {
                            ...match.properties,
                            geometry: match.geometry,
                        };
                    }
                } else if (landParam) {
                    const match = data.features?.find(
                        (f: any) =>
                            f.properties?.landKey === landParam ||
                            f.id === landParam,
                    );
                    targetFeature = match?.properties ?? null;
                } else if (projectNameParam) {
                    const match = data.features?.find(
                        (f: any) =>
                            f.properties?.projectName === projectNameParam,
                    );
                    targetFeature = match?.properties ?? null;
                }

                if (!targetFeature) return;

                if (mapInstance) {
                    flyToAndSelect(mapInstance, targetFeature);
                } else {
                    pendingFeature = targetFeature;
                }
            } catch (error) {
                console.error("Error pre-loading feature:", error);
            }
        })();
    }

    // Block browser page zoom — must be cleaned up on unmount
    const cleanupZoomBlock = blockBrowserZoom();

    return () => {
        cleanup();
        cleanupZoomBlock();
    };
});
</script>

<div class="viewport-layout">
	<main class="demo-map-area">
		<div bind:this={mapContainer} class="mapbox-map"></div>
		{#if splashVisible && variant !== "org"}
			<div class="map-splash" aria-hidden="true">
				<span class="orb orb-a"></span>
				<span class="orb orb-b"></span>
				<span class="orb orb-c"></span>
				<span class="orb orb-d"></span>
				<span class="orb orb-e"></span>
			</div>
		{/if}
		<MapNavButtons />
		<!-- THE DEV READ-OUT. Dev-only by `{#if dev}`, so it is compiled out of
		     every build; portalled into the host's tray when one is given. -->
		{#if dev}
			<output class="dev-readout" use:portal={debugHost} aria-live="polite">
				<span class="k">online map</span> · {variant}
				{#if devCamera}<br />{devCamera}{/if}
				{#if selectedFeature}<br />selected: {selectedFeature.organizationKey ?? selectedFeature.landKey ?? selectedFeature.projectName ?? "?"}{/if}
			</output>
		{/if}
		<MapDrawControls map={mapInstance} {onFeatureComplete} {initialFeatures} />
		<InfoPanel
			bind:selectedFeature
			panel={variant === "org" ? PanelOrg : PanelLand}
			onClose={() => (selectedFeature = null)}
		/>
	</main>
</div>

<style>
	/* The dev read-out, when no host takes it: a pill over the map, under the
	   parent's nav. In a tray the tray neutralises the placement rules. */
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

	/* Push map controls down to avoid navbar overlap */
	:global(.mapboxgl-ctrl-top-left) {
		top: 60px;
	}

	/* Strip Mapbox default popup chrome — our HTML provides its own card */
	:global(.large-poly-popup .mapboxgl-popup-content) {
		background: transparent;
		box-shadow: none;
		padding: 0;
		border-radius: 0;
	}
	:global(.large-poly-popup .mapboxgl-popup-tip) {
		border-bottom-color: #555;
	}

	/* Give the InfoPanel a more prominent border */
	:global(.info-panel) {
		border-color: #555 !important;
	}

	/* Splash: placeholder orbs so users don't stare at a dark globe while
	   the map style + centroids load. Fades out on first map idle. */
	.map-splash {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 5;
		animation: splashFadeOut 0.8s ease-out 2s forwards;
		/* Clip orbs to a circle approximating the globe at initial zoom */
		clip-path: circle(38% at 50% 50%);
	}

	.orb {
		position: absolute;
		display: block;
		border-radius: 9999px;
		background: radial-gradient(
			circle,
			rgba(255, 200, 0, 0.55) 0%,
			rgba(255, 200, 0, 0.25) 45%,
			rgba(255, 200, 0, 0) 70%
		);
		filter: blur(0.5px);
		transform: translate(-50%, -50%);
		animation: orbPulse 1.6s ease-in-out infinite;
	}

	/* Orbs clustered toward center so they stay on the globe */
	.orb-a { top: 40%; left: 38%; width: 64px; height: 64px; animation-delay: 0s; }
	.orb-b { top: 50%; left: 52%; width: 96px; height: 96px; animation-delay: 0.25s; }
	.orb-c { top: 58%; left: 42%; width: 48px; height: 48px; animation-delay: 0.5s; }
	.orb-d { top: 38%; left: 58%; width: 72px; height: 72px; animation-delay: 0.15s; }
	.orb-e { top: 62%; left: 55%; width: 56px; height: 56px; animation-delay: 0.35s; }

	@keyframes orbPulse {
		0%, 100% { opacity: 0.45; transform: translate(-50%, -50%) scale(0.92); }
		50%      { opacity: 0.9;  transform: translate(-50%, -50%) scale(1.08); }
	}

	@keyframes splashFadeOut {
		to { opacity: 0; }
	}

	/* THE MAP IS ITS SLOT. It fills the nearest positioned ancestor edge to
	   edge — .mobile-content inside the phone, the viewport when the child runs
	   alone — and never measures the browser window. Any viewport unit or
	   min-height here makes the map taller than the phone on a big monitor and
	   the shell's overflow-y:auto lets it scroll off the screen. */
	.viewport-layout {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		overscroll-behavior: none;
	}
	.demo-map-area {
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
