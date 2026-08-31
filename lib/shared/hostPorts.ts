/**
 * HOST PORTS — the online map's one door, mirroring the offline child's
 * lib/shared/hostPorts.ts. The child names the contract; a host wires its real
 * store in; a solo checkout passes nothing and the map renders with no pins
 * rather than crashing.
 */
import type { Feature } from "geojson";

/** The slice of the host's map store this page reads. The host's real store
 *  must stay structurally assignable — the host's ports factory asserts it. */
export interface HostMapStore {
	/** Has the host finished hydrating? Pins are not fed until true. */
	readonly ready: boolean;
	readonly activeMapKey: string | null;
	readonly allMaps: readonly { readonly mapKey: string }[];
	/** The active map's features. Point features become clustered pins. */
	readonly features: Feature[];
	switchMap(mapKey: string): void;
}

export interface OnlineMapHostPorts {
	store: HostMapStore;
	/** Legend prefs, as reactive getters so toggles keep working across the
	 *  boundary. Omit → everything visible. */
	visible?: { readonly pins: boolean; readonly plots: boolean };
}
