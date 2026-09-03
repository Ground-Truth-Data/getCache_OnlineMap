import mapboxgl from "mapbox-gl";
import maplibregl from "maplibre-gl";
import { MAP_CONFIG } from "./MAP_CONFIG";
import {
    compactGlobeOptions,
    defaultOptions,
    fullMapOptions,
} from "./mapConfig";
import {
    CustomStyleControl,
    defaultStyleOptions,
    styleIdFromUrl,
} from "./mapControlBaseToggle";
import { addMarkersLayer } from "./mapLayerPolygon";
import type { MapOptions } from "./mapTypes";
import { applyNaturalOverrides, NATURAL_FOG } from "./mapStyleNatural";
import { parseMapHash, setMapHash } from "./mapUtilsHash";
import { safeEase } from "./safeEase";
import { safeJumpTo } from "./safeMap";
import { installCoveringTilesGuard } from "./safeMarker";
// Asset import so the bytes travel with this child — yields a build-time URL
// that resolves under any host, unlike a "/mobileAssets/..." path.
import hospitalPinUrl from "./assets/mobileAssets/hospitalPin.webp";
import { isCoord, toCoordFromArray } from "./coord";
import { glyphStack } from "./glyphStack";

const defaultSatStyle = MAP_CONFIG.styles.defaultSat;

/**
 * `true` so Sentry's replayCanvasIntegration (hooks.client.ts) can snapshot
 * the map; `false` (Mapbox's default) records maps blank in session replays.
 * One switch for BOTH maps (online + offlinev4) — they share this initializer.
 *
 * Measured 2026-08-11: flipping to false was INCONCLUSIVE — run-to-run
 * variance on this route (±100–200 MB) exceeds the effect being tested, and
 * an unproven win is not worth the known replay cost. See MEMORY_FINDINGS.md.
 */
const MAP_PRESERVE_DRAWING_BUFFER = true;

// ── Hospital markers from OpenStreetMap ──────────────────────────────
// Mapbox vector tiles carry no hospital POIs at low zoom, so the hospitals
// near the anchor arrive from the app's endpoint (opts.hospitalsUrl — WORLD
// coverage, already radius-filtered server-side) and render as a custom layer
// at ALL zoom levels.
//
// Holds a BLOB URL (a short string), never the parsed FeatureCollection —
// see fetchHospitals() for why.
let _hospitalGeoJSON: string | null = null;

// The APP's "show me my location" action (opts.onShowMyLocation) — never raw
// geolocation here, which would bypass the app's location gate. Module-level
// for the same reason _hospitalGeoJSON is: the hospital layer is re-added on
// every basemap switch through call sites that don't carry `opts`.
let _onShowMyLocation: (() => void) | null = null;

function addHospitalLayer(map: mapboxgl.Map): void {
    if (!_hospitalGeoJSON) return;
    if (map.getSource("hospitals-osm")) return;

    if (!map.hasImage("hospital-pin")) {
        map.loadImage(hospitalPinUrl, (err, img) => {
            if (err || !img) {
                console.warn(
                    "[Hospitals] Failed to load hospitalPin.png:",
                    err,
                );
                return;
            }
            map.addImage("hospital-pin", img);
            addHospitalLayers(map);
        });
        return;
    }
    addHospitalLayers(map);
}

function addHospitalLayers(map: mapboxgl.Map): void {
    if (map.getSource("hospitals-osm")) return;

    // The loadImage callback path is async — re-check instead of asserting.
    const hospitalGeoJSON = _hospitalGeoJSON;
    if (!hospitalGeoJSON) return;

    map.addSource("hospitals-osm", {
        type: "geojson",
        // A URL, not an object: Mapbox fetches and parses this inside its own
        // worker, so the main thread never holds a second copy.
        data: hospitalGeoJSON,
        cluster: true,
        clusterRadius: 120,
        clusterMaxZoom: 11,
    });

    // Clusters show the same icon — in an emergency the user zooms in anyway.
    map.addLayer({
        id: "hospitals-osm-cluster",
        type: "symbol",
        source: "hospitals-osm",
        filter: ["has", "point_count"],
        minzoom: 6.5,
        layout: {
            "icon-image": "hospital-pin",
            "icon-size": 0.47,
            "icon-allow-overlap": true,
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": 10,
            // Font chosen from the LIVE style — the two maps have disjoint glyph
            // endpoints, so any literal stack 404s forever on one of them. See
            // glyphStack.ts.
            "text-font": glyphStack(map),
            "text-offset": [-0.3, 0.4],
            "text-anchor": "top-right",
            "text-allow-overlap": true,
        },
        paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(0, 0, 0, 0.5)",
            "text-halo-width": 0.8,
        },
    });

    map.addLayer({
        id: "hospitals-osm-icon",
        type: "symbol",
        source: "hospitals-osm",
        filter: ["!", ["has", "point_count"]],
        minzoom: 6.5,
        maxzoom: 22,
        layout: {
            "icon-image": "hospital-pin",
            "icon-size": 0.47,
            "icon-allow-overlap": false,
            // Teardrop pin: the TIP is the coordinate. The default anchor
            // `center` offsets it by half an icon-height in PIXELS, so the
            // pin drifts across the ground as you zoom. Same law as
            // PIN_ANCHOR in pinMarkers.ts.
            "icon-anchor": "bottom",
        },
    });

    // ── Tap hospital → popup with name, distance, your GPS, Call 911 ──
    const openHospitalPopup = (
        hospLng: number,
        hospLat: number,
        name: string,
        phone?: string | null,
    ) => {
        const popupId = `hosp-popup-${Date.now()}`;
        // ⛔ RENDERER-CORRECT Popup. This shell serves BOTH maps (/map is
        // Mapbox, /offline is MapLibre), and a mapboxgl.Popup added to a
        // MapLibre map THROWS ("_requestDomTask is not a function", a
        // Mapbox-private method). The renderer stamps its namespace on the
        // canvas container, so ask the live instance. Local check as in
        // areaLabels.ts — deliberately NOT ReTreever's rendererOf.ts, since
        // rapper must not import `$lib`.
        const PopupCtor = map
            .getCanvasContainer?.()
            ?.className?.includes("maplibregl")
            ? (maplibregl as unknown as { Popup: typeof mapboxgl.Popup }).Popup
            : mapboxgl.Popup;
        const popup = new PopupCtor({ offset: 15, maxWidth: "220px" })
            .setLngLat([hospLng, hospLat])
            .setHTML(
                `<div id="${popupId}" style="font-family:system-ui;font-size:13px;line-height:1.5;color:#222">` +
                    `<strong style="font-size:13px">${name}</strong><br>` +
                    // National-registry rows carry the hospital's own line —
                    // in the field, the switchboard is the second-best number
                    // after 911. Digits+punctuation only: this lands in an
                    // href, and the data is upstream text.
                    (phone && /^[\d\s+().-]{5,25}$/.test(phone)
                        ? `<a href="tel:${phone.replace(/[^\d+]/g, "")}" style="color:#2563eb;` +
                          `text-decoration:none;font-size:12px">${phone}</a><br>`
                        : "") +
                    `<span style="display:flex;gap:6px;margin-top:6px">` +
                    `<a href="tel:911" style="padding:4px 10px;background:#dc3545;color:#fff;` +
                    `border-radius:4px;text-decoration:none;font-weight:600;font-size:12px">911</a>` +
                    `<button id="${popupId}-btn" style="padding:4px 10px;background:#2563eb;color:#fff;` +
                    `border:none;border-radius:4px;font-weight:600;font-size:12px;cursor:pointer">My location</button>` +
                    `</span></div>`,
            )
            .addTo(map);

        // Same action as the LOCATE tile; close the popup first so the
        // coordinate pill isn't buried under it.
        setTimeout(() => {
            const btn = document.getElementById(`${popupId}-btn`);
            if (!btn) return;
            btn.addEventListener("click", () => {
                popup.remove();
                _onShowMyLocation?.();
            });
        }, 0);
    };

    map.on("click", "hospitals-osm-icon", (e) => {
        const feat = e.features?.[0];
        if (!feat || feat.geometry.type !== "Point") return;
        const coord = toCoordFromArray(
            (feat.geometry as GeoJSON.Point).coordinates,
        );
        if (!coord) return;
        openHospitalPopup(
            coord[0],
            coord[1],
            feat.properties?.name ?? "Hospital",
            feat.properties?.phone,
        );
    });

    // Cluster click → open popup for one hospital in the cluster.
    // In an emergency we don't gate care on zoom level.
    map.on("click", "hospitals-osm-cluster", (e) => {
        const feat = e.features?.[0];
        if (!feat || feat.geometry.type !== "Point") return;
        const coord = toCoordFromArray(
            (feat.geometry as GeoJSON.Point).coordinates,
        );
        if (!coord) return;
        const clusterId = feat.properties?.cluster_id;
        const src = map.getSource("hospitals-osm") as
            | mapboxgl.GeoJSONSource
            | undefined;
        if (!src || clusterId == null) {
            openHospitalPopup(coord[0], coord[1], "Hospital");
            return;
        }
        src.getClusterLeaves(clusterId, 1, 0, (err, leaves) => {
            const props = !err ? leaves?.[0]?.properties : null;
            openHospitalPopup(
                coord[0],
                coord[1],
                props?.name ?? "Hospital",
                props?.phone,
            );
        });
    });

    map.on("mouseenter", "hospitals-osm-cluster", () => {
        map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "hospitals-osm-cluster", () => {
        map.getCanvas().style.cursor = "";
    });
    map.on("mouseenter", "hospitals-osm-icon", () => {
        map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "hospitals-osm-icon", () => {
        map.getCanvas().style.cursor = "";
    });
}

/**
 * The endpoint to hit, or null ⇒ no hospital layer at all. Null on either
 * missing input: no anchor means there is no "nearby" to ask about, and no
 * urlFor means the app never configured a hospitals endpoint (rapper is
 * UI-only — hosts and route names are the APP's, never baked in here).
 */
function hospitalsRequestUrl(
    anchor: [number, number] | null,
    urlFor: ((anchor: [number, number]) => string | null) | null | undefined,
): string | null {
    if (!anchor) return null;
    return urlFor?.(anchor) ?? null;
}

async function fetchHospitals(
    map: mapboxgl.Map,
    anchor: [number, number] | null,
    urlFor: ((anchor: [number, number]) => string | null) | null | undefined,
): Promise<void> {
    const url = hospitalsRequestUrl(anchor, urlFor);
    if (!url) return;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Already radius-filtered server-side (worldwide source). Keep only a
        // blob URL — Mapbox fetches and parses it inside its own GL worker, so
        // the main thread never retains the feature graph (the 3,005-feature
        // module-level object this shape replaced was measured retention).
        const blob = new Blob([await res.text()], { type: "application/json" });
        _hospitalGeoJSON = URL.createObjectURL(blob);
        addHospitalLayer(map);
    } catch (err) {
        // Unmount race: SvelteKit cancels in-flight fetches on leaving the
        // page, then mapbox's `idle` fires after teardown and re-calls us.
        // Not a real error — hospitals reload on next mount.
        if ((err as Error)?.message === "Failed to fetch") return;
        console.error("[Hospitals] Failed to load hospitals:", err);
    }
}

function startRotation(
    map: mapboxgl.Map,
    options: MapOptions,
    userInteractingRef: { current: boolean },
): void {
    const degreesPerSecond =
        options.rotationSpeed ?? MAP_CONFIG.globe.rotationSpeed;
    const maxSpinZoom = MAP_CONFIG.globe.maxSpinZoom;

    // Manual rAF spin instead of easeTo. mapbox 3.x globe projection has an
    // internal recursion in setLocationAtPoint → set center →
    // _updateZoomFromElevation that easeTo triggers on every per-frame update.
    // jumpTo skips setLocationAtPoint entirely and just sets center, so no
    // elevation anchor recompute, no stack overflow.
    let raf = 0;
    let lastT = 0;
    // Latch so a corrupt camera is reset once, not every frame.
    let cameraRecovered = false;

    function step(t: number) {
        if (!map) return;
        const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
        lastT = t;

        // The spin yields to any camera the user is driving. Ask Mapbox —
        // isMoving/isZooming/isRotating cover every camera change it drives,
        // including gestures an enumerated event list misses (pinch's first
        // touchend, wheel zoom — both once let this loop re-assert zoom every
        // frame and swallow the user's input). The ref survives only as a
        // manual OVERRIDE: mousedown holds the globe still before a click.
        const userDrivingCamera =
            userInteractingRef.current ||
            map.isMoving() ||
            map.isZooming() ||
            map.isRotating();

        if (!userDrivingCamera && map.getZoom() < maxSpinZoom && dt > 0) {
            const center = map.getCenter();
            const centerOk =
                Number.isFinite(center.lng) && Number.isFinite(center.lat);

            if (centerOk) {
                cameraRecovered = false; // healthy — re-arm recovery
                center.lng -= degreesPerSecond * dt;
                safeJumpTo(map, {
                    center: [center.lng, center.lat],
                    zoom: map.getZoom(),
                });
            } else if (!cameraRecovered) {
                // Corrupt camera (NaN center): without the latch this re-reads
                // the NaN every frame and spams safeJumpTo's rejection ~60×/s.
                // Reset once; the next frame sees a finite center and resumes.
                cameraRecovered = true;
                const fallback = options.initialCenter;
                safeJumpTo(map, {
                    center:
                        fallback &&
                        Number.isFinite(fallback[0]) &&
                        Number.isFinite(fallback[1])
                            ? fallback
                            : [0, 20],
                    zoom: Number.isFinite(options.initialZoom)
                        ? (options.initialZoom as number)
                        : 1.5,
                });
            }
        }
        raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);

    map.once("remove", () => {
        if (raf) cancelAnimationFrame(raf);
    });
}

/**
 * Initialize a Mapbox map (compactGlobeOptions for the hero globe).
 * Returns a cleanup function that removes the map.
 */
export function initializeMap(
    container: HTMLDivElement,
    options: MapOptions = {},
): () => void {
    const opts = { ...defaultOptions, ...options };
    _onShowMyLocation = opts.onShowMyLocation ?? null;
    const mapboxAccessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    const maxSpinZoom = MAP_CONFIG.globe.maxSpinZoom;

    if (opts.enableHash && typeof window !== "undefined") {
        const parsed = parseMapHash(window.location.hash);
        if (parsed) {
            opts.initialZoom = parsed.zoom;
            opts.initialCenter = parsed.center;
        }
    }

    if (!mapboxAccessToken) {
        // Name the variable in the message — it appears in no file that
        // ships (it lives in ReTreever/.env.schema, outside this repo), so
        // there is otherwise nothing to search for.
        const name = "VITE_MAPBOX_TOKEN";
        const msg =
            `${name} is not set, so no map can be created.\n` +
            `Add it to rapper/.env (see rapper/.env.example) and restart the dev server.\n` +
            `Free tokens: https://account.mapbox.com/access-tokens/`;
        console.error(msg);

        // Painted into the container — a blank rectangle reads as "broken",
        // not "unconfigured". textContent, not innerHTML: nothing can inject.
        const note = document.createElement("div");
        note.style.cssText =
            "padding:1rem;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
            "white-space:pre-wrap;color:#b3261e;background:#fff4f2;border:1px solid #f0c9c2;" +
            "border-radius:6px;margin:1rem;max-width:52ch";
        note.textContent = msg;
        container.appendChild(note);

        return () => {
            // Otherwise a re-init stacks a second copy.
            note.remove();
        };
    }

    mapboxgl.accessToken = mapboxAccessToken;

    const userInteractingRef = { current: false };

    // parseMapHash can return garbage; callers can pass a stale-store camera
    // carrying NaN. The watchdog below recovers AFTER the fact, but mapbox's
    // mousemove handler can throw "Invalid LngLat object: (NaN, NaN)" on a
    // degenerate transform first — validate so the transform is born finite.
    const safeCenter: [number, number] = isCoord(opts.initialCenter)
        ? ([opts.initialCenter[0], opts.initialCenter[1]] as [number, number])
        : ([
              defaultOptions.initialCenter[0],
              defaultOptions.initialCenter[1],
          ] as [number, number]);
    const safeZoom: number = Number.isFinite(opts.initialZoom)
        ? (opts.initialZoom as number)
        : (defaultOptions.initialZoom as number);
    if (
        safeCenter[0] !== opts.initialCenter?.[0] ||
        safeCenter[1] !== opts.initialCenter?.[1] ||
        safeZoom !== opts.initialZoom
    ) {
        console.warn("[mapInit] degenerate initial camera — using defaults", {
            got: { center: opts.initialCenter, zoom: opts.initialZoom },
            using: { center: safeCenter, zoom: safeZoom },
        });
    }

    const map = new mapboxgl.Map({
        container,
        style: opts.style || defaultSatStyle,
        // Optional request rewriter/blocker (air-gapped offline maps pass a guard
        // that rejects every non-local URL — see /mobile/offlinev4).
        ...(opts.transformRequest
            ? { transformRequest: opts.transformRequest }
            : {}),
        hash: false,
        // Both credit controls are placed ONCE, at construction — no API to
        // move them later, and CSS only ever moves their whole corner
        // container. `logoPosition` moves the wordmark; the attribution has
        // no equivalent, so it's disabled here and re-added by hand below.
        ...(opts.creditsSplit
            ? {
                  logoPosition: "bottom-right" as const,
                  attributionControl: false,
              }
            : {}),
        center: safeCenter,
        zoom: safeZoom,
        projection: opts.globeProjection ? "globe" : "mercator",
        interactive: true,
        pitch: 0,
        bearing: 0,
        preserveDrawingBuffer: MAP_PRESERVE_DRAWING_BUFFER,
    });

    // Guard the geojson worker-callback crash path (SourceCache.update →
    // Transform.coveringTiles) — patches the shared Transform prototype off
    // this live instance. Must come right after construction so a source
    // 'data' event landing during a degenerate-camera window can't throw.
    installCoveringTilesGuard(map);

    // Dev-only QA handle: lets browser-automation sessions aim the camera
    // (jumpTo/querySourceFeatures) without synthetic-gesture flailing.
    if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__rtMap = map;
    }

    // Construction-time handle — fires BEFORE the style loads (onMapReady
    // waits for `load`, which can hang on a weak connection). See MapOptions.
    opts.onMapCreated?.(map);

    // Lock to top-down view.
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    // ── WebGL context recovery (iOS WebView) ────────────────────────────
    // iOS WebKit reclaims a WebView's GL context under memory pressure or a
    // heavy reflow (popover, software keyboard); mapbox-gl never rebuilds it,
    // and the browser only sends `webglcontextrestored` if the loss was
    // preventDefault'd — do that, then resize + repaint so tiles redraw.
    // Desktop effectively never fires these; only native iOS reproduces it.
    const glCanvas = map.getCanvas();
    const onContextLost = (e: Event) => {
        e.preventDefault();
        console.warn("[mapInit] WebGL context lost — awaiting restore");
    };
    const onContextRestored = () => {
        console.warn("[mapInit] WebGL context restored — repainting map");
        map.resize();
        map.triggerRepaint();
    };
    glCanvas.addEventListener("webglcontextlost", onContextLost, false);
    glCanvas.addEventListener("webglcontextrestored", onContextRestored, false);

    // ── Camera / canvas health watchdog ─────────────────────────────────
    // A pointer/resize event while the container is momentarily zero-sized
    // (overlay popover, iOS keyboard) makes mapbox-gl's projection math
    // divide by zero: a NaN camera or a 0×0 canvas, both blank white, never
    // self-repaired — and startRotation's recovery path doesn't run on the
    // non-rotating mobile work map. Re-check a few times a second and repair
    // whichever degenerate state is found.
    let lastGoodCenter: [number, number] = safeCenter;
    let lastGoodZoom = safeZoom;
    // Warn once per episode, not per 400ms tick.
    let unhealthySince: number | null = null;
    map.on("moveend", () => {
        const c = map.getCenter();
        if (Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
            lastGoodCenter = [c.lng, c.lat];
            const z = map.getZoom();
            if (Number.isFinite(z)) lastGoodZoom = z;
        }
    });
    const healthWatchdog = window.setInterval(() => {
        // Center OR zoom non-finite: a NaN zoom from an animation started
        // with garbage makes unproject return NaN and the map never draws.
        let cameraBad = false;
        try {
            const c = map.getCenter();
            const z = map.getZoom();
            cameraBad =
                !Number.isFinite(c.lng) ||
                !Number.isFinite(c.lat) ||
                !Number.isFinite(z);
        } catch {
            // getCenter()/getZoom() can themselves throw when the transform
            // is fully degenerate — treat that as "bad" and recover.
            cameraBad = true;
        }
        const canvasEl = map.getCanvas();
        const cont = map.getContainer();
        const canvasDead =
            cont.clientWidth > 0 &&
            cont.clientHeight > 0 &&
            (canvasEl.clientWidth === 0 || canvasEl.clientHeight === 0);
        if (cameraBad) {
            if (unhealthySince === null) {
                console.warn(
                    "[mapInit] camera transform degenerate — restoring last good view",
                );
            }
            // Cancels the in-flight NaN animation and pins the camera finite.
            safeJumpTo(map, { center: lastGoodCenter, zoom: lastGoodZoom });
        }
        if (cameraBad || canvasDead) {
            unhealthySince ??= Date.now();
            map.resize();
            map.triggerRepaint();
        } else if (unhealthySince !== null) {
            console.warn(
                `[mapInit] map healthy again after ${Math.round((Date.now() - unhealthySince) / 1000)}s`,
            );
            unhealthySince = null;
        }
    }, 400);

    // Force terrain off. On globe projection, any DEM source causes mapbox-gl's
    // setLocationAtPoint → set center → _updateZoomFromElevation → getAtPoint
    // chain to recurse and blow the stack during animated easeTo (e.g. spin).
    map.on("style.load", () => {
        map.setTerrain(null);
    });

    if (opts.enableHash) {
        map.on("moveend", () => {
            if (map.getZoom() < maxSpinZoom) return;
            setMapHash(map, opts.writeHash);
        });
    }

    if (!opts.scrollZoom) {
        map.scrollZoom.disable();
    } else {
        // Mapbox default (1/450) ≈ 1 zoom level per full trackpad swipe; at
        // 1/60 a swipe ≈ 7–8 levels — globe to site in 2 gestures. Tiles
        // lazy-load after the user settles.
        map.scrollZoom.setWheelZoomRate(1 / 60);
        map.scrollZoom.setZoomRate(1 / 35);
    }

    if (opts.autoRotate) {
        // mousedown must freeze the globe SYNCHRONOUSLY: the rAF step reads
        // the ref next frame, so the already-scheduled frame still slides the
        // world under a stationary cursor — and mapbox hit-tests at mouseup,
        // so the click misses its target. map.stop() cancels the in-flight
        // camera change on the spot.
        map.on("mousedown", () => {
            userInteractingRef.current = true;
            map.stop();
            opts.onUserInteractionStart?.();
        });
        map.on("mouseup", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });

        // touchstart/touchend are NOT a balanced pair with multiple fingers
        // down: the FIRST touchend arrives while the second finger is still
        // pinching, and releasing then lets the spin loop fight the zoom.
        // Only release when the LAST finger lifts — `originalEvent.touches`
        // is the live count.
        map.on("touchstart", () => {
            userInteractingRef.current = true;
            map.stop();
            opts.onUserInteractionStart?.();
        });
        map.on("touchend", (e) => {
            if ((e.originalEvent?.touches?.length ?? 0) > 0) return;
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });
        // A cancelled touch (call, notification, browser gesture takeover)
        // fires NO touchend. Without this the ref latches true and the globe
        // never spins again for the rest of the session.
        map.on("touchcancel", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });

        map.on("dragstart", () => {
            userInteractingRef.current = true;
            opts.onUserInteractionStart?.();
        });
        map.on("dragend", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });
    }

    // Unified style.load handler — fog, natural overrides, label hiding.
    // Fires on initial load AND after setStyle (style toggle).
    if (opts.globeProjection || opts.hideLabels || opts.showHospitalMarkers) {
        map.on("style.load", () => {
            // ── Fog ────────────────────────────────────────────────────
            if (opts.globeProjection) {
                if (opts.transparentBackground) {
                    map.setFog({
                        color: "white",
                        "high-color": "white",
                        "horizon-blend": 0.015,
                        "space-color": "white",
                        "star-intensity": 0.4,
                    });
                } else {
                    const name = map.getStyle()?.name?.toLowerCase() ?? "";
                    const isDark = name.includes("dark");
                    map.setFog(
                        isDark
                            ? NATURAL_FOG
                            : {
                                  color: "rgba(186, 210, 235, 0.35)",
                                  "high-color": "rgba(36, 92, 223, 0.18)",
                                  "horizon-blend": 0.015,
                                  "space-color": "rgb(11, 11, 25)",
                                  "star-intensity": 0.4,
                              },
                    );

                    // ── Natural style overrides (only on dark-v11) ─────
                    if (isDark) {
                        applyNaturalOverrides(map);
                    }
                }
            }

            // ── Hide labels ────────────────────────────────────────────
            // Natural overrides already hide all symbols, but this covers
            // non-natural styles when hideLabels is explicitly on.
            if (opts.hideLabels) {
                const layers = map.getStyle()?.layers || [];
                const whitelist = opts.labelWhitelist ?? [];
                for (const layer of layers) {
                    if (layer.type !== "symbol") continue;
                    // Keep whitelisted layers visible (e.g. road-, settlement-)
                    const isWhitelisted =
                        whitelist.length > 0 &&
                        whitelist.some((prefix) => layer.id.startsWith(prefix));
                    if (isWhitelisted) continue;
                    try {
                        const hasText =
                            map.getLayoutProperty(layer.id, "text-field") !=
                            null;
                        if (hasText)
                            map.setLayoutProperty(
                                layer.id,
                                "visibility",
                                "none",
                            );
                    } catch {
                        // codestyle-allow-swallow: hiding a label layer is cosmetic; a style not yet loaded / missing layer id just leaves it visible
                    }
                }
            }

            // Re-add cached hospital layer after basemap switch.
            if (opts.showHospitalMarkers) {
                addHospitalLayer(map);
            }
        });
    }

    // Attribution re-added on the OTHER side from the wordmark (disabled in
    // the constructor so it can be positioned; mapbox's terms require it to
    // stay visible). `compact: false` keeps it a readable line rather than
    // an (i) button at narrow widths.
    if (opts.creditsSplit) {
        map.addControl(
            new mapboxgl.AttributionControl({ compact: false }),
            "bottom-left",
        );
    }

    if (opts.showNavigation && !opts.mobileControls) {
        const nc = new mapboxgl.NavigationControl();
        map.addControl(nc, "top-left");
    }

    if ((opts.showScale ?? opts.showNavigation) && !opts.mobileControls) {
        const scaleControl = new mapboxgl.ScaleControl({
            maxWidth: 160,
            unit: "metric",
        });
        // /where opts into bottom-right so the scale joins the zoom readout
        // and credits in one corner cluster, not stranded diagonally opposite.
        map.addControl(
            scaleControl,
            opts.cornerControlsBottomRight ? "bottom-right" : "bottom-left",
        );
    }

    // ── Zoom readout ───────────────────────────────────────────────────
    // Debug aid. Zoom decides spin, dog size and cluster splits; the URL
    // hash only syncs above maxSpinZoom, so it's blank for the whole
    // spinning range.
    if (opts.showZoomReadout) {
        const readout = document.createElement("div");
        readout.className = "mapboxgl-ctrl rt-zoom-readout";
        readout.setAttribute("aria-hidden", "true");

        const paint = () => {
            readout.textContent = `z${map.getZoom().toFixed(1)}`;
        };
        paint();
        map.on("zoom", paint);
        map.on("move", paint);

        map.addControl(
            {
                onAdd: () => readout,
                onRemove: () => {
                    map.off("zoom", paint);
                    map.off("move", paint);
                    readout.remove();
                },
            },
            "bottom-right",
        );
    }

    if (opts.showStyleControl) {
        const initialStyleId = styleIdFromUrl(
            opts.style ?? defaultSatStyle,
            defaultStyleOptions,
        );
        const stylePosition = opts.mobileControls ? "top-right" : "top-left";
        map.addControl(
            new CustomStyleControl(defaultStyleOptions, initialStyleId),
            stylePosition,
        );
    }

    // Elastic zoom: hard limits sit `overshoot` past the soft ones and
    // zoomend eases back — the gesture visibly registers instead of
    // hard-stopping (mapDocs.md).
    const { softMin, softMax, overshoot, easeMs } = MAP_CONFIG.zoom;
    map.setMinZoom(softMin - overshoot);
    map.setMaxZoom(softMax + overshoot);
    map.on("zoomend", () => {
        const z = map.getZoom();
        if (z > softMax) safeEase(map, { zoom: softMax, duration: easeMs });
        else if (z < softMin) safeEase(map, { zoom: softMin, duration: easeMs });
    });

    map.on("load", async () => {
        map.resize();
        if (opts.showHospitalMarkers) {
            // Anchor comes from the APP (rapper is UI-only, no mobile stores)
            // and is read HERE, not at construction — it hydrates async, so
            // an early capture is the app's fallback, not the user's position.
            fetchHospitals(
                map,
                opts.hospitalAnchor?.() ?? null,
                opts.hospitalsUrl,
            );
        }
        if (opts.loadMarkers) await addMarkersLayer(map, opts);
        // Draw tools live in <MapDrawControls> on the page components.
        if (opts.autoRotate) startRotation(map, opts, userInteractingRef);
        opts.onMapReady?.(map);
    });

    return () => {
        window.clearInterval(healthWatchdog);
        glCanvas.removeEventListener("webglcontextlost", onContextLost);
        glCanvas.removeEventListener("webglcontextrestored", onContextRestored);
        map.remove();
    };
}

// Re-export config options for backward compatibility
export { fullMapOptions, compactGlobeOptions };

export type { ClusteredPinsConfig } from "./mapMarker";
// Re-export types for backward compatibility
export type { MapOptions, PolygonConfig } from "./mapTypes";

/**
 * For hospitalCost.test.ts ONLY — the load's SHAPE is the guarded thing (no
 * anchor/endpoint ⇒ no request at all); the bug class it guards was invisible
 * to correctness tests.
 */
export const __testing = { hospitalsRequestUrl };
