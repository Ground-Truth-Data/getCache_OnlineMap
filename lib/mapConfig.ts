import { MAP_CONFIG } from "./MAP_CONFIG";
import type { MapOptions } from "./mapTypes";

export const fullMapOptions: MapOptions = {
    showNavigation: true,
    showStyleControl: true,
    showGeoToggle: false,
    showDrawTools: false,
    hideLabels: true,
    loadMarkers: true,
    enableHash: true,
    globeProjection: true,
    autoRotate: true,
    rotationSpeed: 2,
    scrollZoom: true,
    initialZoom: 2,
    initialCenter: [38.32379156163088, -4.920169086710128],
    style: MAP_CONFIG.styles.defaultSat,
};

export const defaultOptions = {
    compact: false,
    showNavigation: false,
    showStyleControl: false,
    showGeoToggle: false,
    showDrawTools: false,
    loadMarkers: false,
    enableHash: false,
    globeProjection: false,
    autoRotate: false,
    rotationSpeed: 2,
    scrollZoom: true,
    initialZoom: 2,
    initialCenter: [38.32379156163088, -4.920169086710128], // Tanzania
    style: MAP_CONFIG.styles.defaultSat,
} satisfies MapOptions;

export const compactGlobeOptions: MapOptions = {
    hideLabels: true,
    loadMarkers: true,
    globeProjection: true,
    autoRotate: true,
    rotationSpeed: 1.5,
    style: MAP_CONFIG.styles.defaultDark,
};
