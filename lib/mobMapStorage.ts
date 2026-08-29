// Storage differs by runtime: native → @capacitor/filesystem (real disk); web → OPFS (backed by IndexedDB).

import { Capacitor } from "@capacitor/core";

// Resolved at call time (not module load) so sandbox mode can redirect to "maps-sandbox"; reads a window global rather than importing $lib/mobile (open-core). Absent global → real "maps".
function mapsDir(): string {
	const active =
		typeof window !== "undefined" &&
		(window as { __rt_sandbox_active?: boolean }).__rt_sandbox_active === true;
	return active ? "maps-sandbox" : "maps";
}
const META_FILE = "maps-meta.json";
const MAX_STORED_MAPS = 20;

export interface StoredMap {
	key: string;
	name: string;
	sizeBytes: number;
	savedAt: Date;
}

interface MetaRecord {
	key: string;
	name: string;
	sizeBytes: number;
	savedAt: string;
}

/** URL for a stored overlay + a revoke callback the caller MUST invoke when done (no-op on native; revokes the blob URL on web). */
export interface OverlayHandle {
	url: string;
	revoke: () => void;
}

const isNative = () => Capacitor.isNativePlatform();

function safeKey(filename: string): string {
	return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// LRU eviction here can't touch the owning feature row (lives in the proprietary store, open-core split) — emit evicted keys via onMapsEvicted so the store side sweeps orphaned rows.
type EvictionListener = (evictedKeys: string[]) => void;
let evictionListener: EvictionListener | null = null;

export function onMapsEvicted(listener: EvictionListener | null): void {
	evictionListener = listener;
}

function notifyEvicted(keys: string[]): void {
	if (!keys.length || !evictionListener) return;
	try {
		evictionListener(keys);
	} catch {
		// A listener throwing must never break a storage save.
	}
}

async function nativeFs() {
	const { Filesystem, Directory, Encoding } = await import(
		"@capacitor/filesystem"
	);
	return { Filesystem, Directory, Encoding };
}

async function nativeReadMeta(): Promise<MetaRecord[]> {
	const { Filesystem, Directory, Encoding } = await nativeFs();
	try {
		const res = await Filesystem.readFile({
			path: `${mapsDir()}/${META_FILE}`,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
		});
		return JSON.parse(res.data as string) as MetaRecord[];
	} catch {
		return [];
	}
}

async function nativeWriteMeta(records: MetaRecord[]): Promise<void> {
	const { Filesystem, Directory, Encoding } = await nativeFs();
	await Filesystem.writeFile({
		path: `${mapsDir()}/${META_FILE}`,
		directory: Directory.Data,
		encoding: Encoding.UTF8,
		data: JSON.stringify(records),
		recursive: true,
	});
}

async function nativeSave(file: File): Promise<string> {
	const { Filesystem, Directory } = await nativeFs();
	const key = safeKey(file.name);
	// base64 is the only way to ship binary through the Capacitor bridge.
	const buf = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < buf.length; i += chunk) {
		binary += String.fromCharCode(...buf.subarray(i, i + chunk));
	}
	const base64 = btoa(binary);
	await Filesystem.writeFile({
		path: `${mapsDir()}/${key}`,
		directory: Directory.Data,
		data: base64,
		recursive: true,
	});
	return key;
}

async function nativeLoad(key: string): Promise<File> {
	const { Filesystem, Directory } = await nativeFs();
	const res = await Filesystem.readFile({
		path: `${mapsDir()}/${key}`,
		directory: Directory.Data,
	});
	const base64 = res.data as string;
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const records = await nativeReadMeta();
	const meta = records.find((r) => r.key === key);
	return new File([bytes], meta?.name ?? key, { type: "image/webp" });
}

async function nativeDelete(key: string): Promise<void> {
	const { Filesystem, Directory } = await nativeFs();
	try {
		await Filesystem.deleteFile({
			path: `${mapsDir()}/${key}`,
			directory: Directory.Data,
		});
	} catch {
		// already gone
	}
}

async function nativeGetUrl(key: string): Promise<OverlayHandle> {
	const { Filesystem, Directory } = await nativeFs();
	const { uri } = await Filesystem.getUri({
		path: `${mapsDir()}/${key}`,
		directory: Directory.Data,
	});
	// Capacitor file:// URLs fail in WKWebView/Android WebView — must rewrite to capacitor://localhost/_capacitor_file_/... (see MAP_IMPORT_HANDOFF.md gotcha 3).
	return {
		url: Capacitor.convertFileSrc(uri),
		revoke: () => {
			/* native path serves a file:// rewrite — no blob URL to revoke */
		},
	};
}

async function getMapsDir(): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(mapsDir(), { create: true });
}

async function webReadMeta(
	root: FileSystemDirectoryHandle,
): Promise<MetaRecord[]> {
	try {
		const fh = await root.getFileHandle(META_FILE);
		const file = await fh.getFile();
		return JSON.parse(await file.text()) as MetaRecord[];
	} catch {
		return [];
	}
}

async function webWriteMeta(
	root: FileSystemDirectoryHandle,
	records: MetaRecord[],
): Promise<void> {
	const fh = await root.getFileHandle(META_FILE, { create: true });
	const writable = await fh.createWritable();
	await writable.write(JSON.stringify(records));
	await writable.close();
}

async function webSave(file: File): Promise<string> {
	const dir = await getMapsDir();
	const key = safeKey(file.name);
	const fh = await dir.getFileHandle(key, { create: true });
	const writable = await fh.createWritable();
	try {
		// Pass the Blob directly (not file.arrayBuffer()) — arrayBuffer() OOMed Safari on the old multi-MB PDFs; the browser streams a Blob write directly.
		await writable.write(file);
		await writable.close();
	} catch (e) {
		try {
			await writable.close();
		} catch {
			// Second close of an already-failed stream is intentionally swallowed — `e` is rethrown/classified below.
		}
		const msg = (e as Error).message ?? "";
		if (
			msg.includes("unknown transient") ||
			msg.includes("memory") ||
			msg.includes("quota")
		) {
			throw new Error(
				`Browser ran out of storage saving "${file.name}". Try a smaller map, or use the installed app.`,
			);
		}
		throw e;
	}

	let records = await webReadMeta(dir);
	records = records.filter((r) => r.key !== key);
	records.push({
		key,
		name: file.name,
		sizeBytes: file.size,
		savedAt: new Date().toISOString(),
	});
	if (records.length > MAX_STORED_MAPS) {
		records.sort(
			(a, b) =>
				new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime(),
		);
		const toRemove = records.splice(0, records.length - MAX_STORED_MAPS);
		for (const r of toRemove) {
			try {
				await dir.removeEntry(r.key);
			} catch {
				/* ignore missing files */
			}
		}
		notifyEvicted(toRemove.map((r) => r.key));
	}
	await webWriteMeta(dir, records);
	return key;
}

async function webLoad(key: string): Promise<File> {
	const dir = await getMapsDir();
	const fh = await dir.getFileHandle(key);
	const file = await fh.getFile();
	const records = await webReadMeta(dir);
	const meta = records.find((r) => r.key === key);
	return new File([file], meta?.name ?? key, { type: "image/webp" });
}

async function webDelete(key: string): Promise<void> {
	const dir = await getMapsDir();
	try {
		await dir.removeEntry(key);
	} catch {
		/* already gone */
	}
}

async function webGetUrl(key: string): Promise<OverlayHandle> {
	const dir = await getMapsDir();
	const fh = await dir.getFileHandle(key);
	const file = await fh.getFile();
	const url = URL.createObjectURL(file);
	return { url, revoke: () => URL.revokeObjectURL(url) };
}

export async function saveMap(file: File): Promise<string> {
	if (isNative()) {
		const key = await nativeSave(file);
		let records = await nativeReadMeta();
		records = records.filter((r) => r.key !== key);
		records.push({
			key,
			name: file.name,
			sizeBytes: file.size,
			savedAt: new Date().toISOString(),
		});
		if (records.length > MAX_STORED_MAPS) {
			records.sort(
				(a, b) =>
					new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime(),
			);
			const toRemove = records.splice(0, records.length - MAX_STORED_MAPS);
			for (const r of toRemove) await nativeDelete(r.key);
			notifyEvicted(toRemove.map((r) => r.key));
		}
		await nativeWriteMeta(records);
		return key;
	}
	return webSave(file);
}

export async function listMaps(): Promise<StoredMap[]> {
	const records = isNative()
		? await nativeReadMeta()
		: await webReadMeta(await getMapsDir());
	return records
		.map((r) => ({ ...r, savedAt: new Date(r.savedAt) }))
		.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}

export async function loadMap(key: string): Promise<File> {
	return isNative() ? nativeLoad(key) : webLoad(key);
}

/** URL for Mapbox ImageSource. The handle MUST be revoked by the caller (no-op on native, frees the blob URL on web). */
export async function getMapUrl(key: string): Promise<OverlayHandle> {
	return isNative() ? nativeGetUrl(key) : webGetUrl(key);
}

export async function deleteMap(key: string): Promise<void> {
	if (isNative()) {
		await nativeDelete(key);
		const records = (await nativeReadMeta()).filter((r) => r.key !== key);
		await nativeWriteMeta(records);
		return;
	}
	await webDelete(key);
	const dir = await getMapsDir();
	const records = (await webReadMeta(dir)).filter((r) => r.key !== key);
	await webWriteMeta(dir, records);
}

export async function storageEstimate(): Promise<{
	used: number;
	quota: number;
}> {
	if (isNative()) {
		return { used: 0, quota: Number.POSITIVE_INFINITY };
	}
	const estimate = await navigator.storage.estimate();
	return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

function tileDir(mapKey: string): string {
	return `${mapsDir()}/${safeKey(mapKey)}`;
}

// Baked package (gdalConvert/tippecanoe, Phase 5): ZIP of vtiles/{z}/{x}/{y}.pbf + vsidecar.json.
// vsidecar.json name is fixed — renaming it would orphan existing on-device bakes.
// NATIVE ONLY for v1 — web has no OPFS tile-serving Service Worker yet; fails loudly rather than silently degrading.

const VTILES_SUBDIR = "vtiles";
const VSIDECAR_FILE = "vsidecar.json";
// Container writes the sidecar as sidecar.json (mismatched with the client's vsidecar.json) — accept either name when unpacking; saveVectorTilePackage re-writes canonically on disk.
const CONTAINER_SIDECAR_FILE = "sidecar.json";

export interface VectorTileSidecar {
	schemaVersion: number;
	bounds: { n: number; s: number; e: number; w: number };
	epsg: number;
	minzoom: number;
	maxzoom: number;
	bakedAt: number;
	/** Total feature count baked into the pyramid — surfaced in the inbox card subtitle without re-reading any tile. */
	featureCount?: number;
	/** Tile body format — today "mvt" (gzip-compressed protobuf), what tippecanoe emits; reserved for future variants. */
	vtileFormat?: string;
	sourceFile?: string;
}

/** Unpack a baked vector-tile-package ZIP into mobMapStorage/{mapKey}/vtiles/, returning the parsed sidecar. NATIVE ONLY — throws on web for now. */
export async function saveVectorTilePackage(
	mapKey: string,
	zipFile: File,
): Promise<VectorTileSidecar> {
	if (!isNative()) {
		throw new Error(
			"[mobMapStorage] vector tile pyramid is native-only in v1; web has no OPFS tile-serving path",
		);
	}
	const { Filesystem, Directory, Encoding } = await nativeFs();
	const { unzipSync, strFromU8 } = await import("fflate");
	const root = tileDir(mapKey);
	const vtilesRoot = `${root}/${VTILES_SUBDIR}`;

	// Wipe only the vtiles subdir, NOT the whole map directory — a sibling raster tile package (e.g. from a mixed KMZ) may live alongside and must survive.
	try {
		await Filesystem.rmdir({
			path: vtilesRoot,
			directory: Directory.Data,
			recursive: true,
		});
	} catch {
		// not present — first bake for this map
	}
	// Also remove a previous sidecar so a half-written package can't survive.
	try {
		await Filesystem.deleteFile({
			path: `${root}/${VSIDECAR_FILE}`,
			directory: Directory.Data,
		});
	} catch {
		// not present
	}

	const buf = new Uint8Array(await zipFile.arrayBuffer());
	const entries = unzipSync(buf);

	let sidecar: VectorTileSidecar | null = null;
	for (const [name, bytes] of Object.entries(entries)) {
		if (name.endsWith("/")) continue; // directory entry
		// Normalise the container's sidecar.json to the client's canonical vsidecar.json on disk; tiles ride through under their own names.
		const onDiskName =
			name === CONTAINER_SIDECAR_FILE ? VSIDECAR_FILE : name;
		const path = `${root}/${onDiskName}`;
		// base64 encode for the Capacitor bridge — same trick as nativeSave.
		let binary = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		const base64 = btoa(binary);
		await Filesystem.writeFile({
			path,
			directory: Directory.Data,
			data: base64,
			recursive: true,
		});
		if (name === VSIDECAR_FILE || name === CONTAINER_SIDECAR_FILE) {
			sidecar = JSON.parse(strFromU8(bytes)) as VectorTileSidecar;
		}
	}

	if (!sidecar) {
		throw new Error(
			`[mobMapStorage] vector tile package for ${mapKey} missing ${VSIDECAR_FILE}`,
		);
	}
	// Re-write the sidecar as canonical JSON so a downstream read parses cleanly regardless of how the bake serialized it.
	await Filesystem.writeFile({
		path: `${root}/${VSIDECAR_FILE}`,
		directory: Directory.Data,
		encoding: Encoding.UTF8,
		data: JSON.stringify(sidecar),
		recursive: false,
	});
	return sidecar;
}

/** Read the vector-tile sidecar for a map. Returns null if none is on disk (cloud-restored device → caller surfaces TILES_NOT_ON_DEVICE). NATIVE ONLY. */
export async function readVectorTileSidecar(
	mapKey: string,
): Promise<VectorTileSidecar | null> {
	if (!isNative()) return null;
	const { Filesystem, Directory, Encoding } = await nativeFs();
	try {
		const res = await Filesystem.readFile({
			path: `${tileDir(mapKey)}/${VSIDECAR_FILE}`,
			directory: Directory.Data,
			encoding: Encoding.UTF8,
		});
		return JSON.parse(res.data as string) as VectorTileSidecar;
	} catch {
		return null;
	}
}

/** True if a vector tile pyramid is on disk for this mapKey — used to decide between mounting a VectorSource and surfacing TILES_NOT_ON_DEVICE. */
export async function hasVectorTilesOnDisk(mapKey: string): Promise<boolean> {
	if (!isNative()) return false;
	return (await readVectorTileSidecar(mapKey)) !== null;
}

/** Mapbox VectorSource tiles template for the on-disk pyramid ({z}/{x}/{y} interpolated by Mapbox). NATIVE ONLY — web doesn't expose Filesystem URIs as fetchable URLs. */
export async function getVectorTileUrlTemplate(
	mapKey: string,
): Promise<string> {
	if (!isNative()) {
		throw new Error(
			"[mobMapStorage] getVectorTileUrlTemplate is native-only",
		);
	}
	const { Filesystem, Directory } = await nativeFs();
	const { uri } = await Filesystem.getUri({
		path: `${tileDir(mapKey)}/${VTILES_SUBDIR}`,
		directory: Directory.Data,
	});
	// Capacitor.convertFileSrc rewrites file:// → capacitor://localhost/...; .pbf is the conventional MVT extension tippecanoe emits.
	return `${Capacitor.convertFileSrc(uri)}/{z}/{x}/{y}.pbf`;
}

/** Wipe a map's vector tile package (vtiles subdir + sidecar) — idempotent; leaves any sibling raster tile package intact. */
export async function deleteVectorTilePackage(mapKey: string): Promise<void> {
	if (!isNative()) return;
	const { Filesystem, Directory } = await nativeFs();
	const root = tileDir(mapKey);
	try {
		await Filesystem.rmdir({
			path: `${root}/${VTILES_SUBDIR}`,
			directory: Directory.Data,
			recursive: true,
		});
	} catch {
		// already gone
	}
	try {
		await Filesystem.deleteFile({
			path: `${root}/${VSIDECAR_FILE}`,
			directory: Directory.Data,
		});
	} catch {
		// already gone
	}
}
