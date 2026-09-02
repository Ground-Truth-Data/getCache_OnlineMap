<script lang="ts">
import { dev } from "$app/environment";
/**
 * /map/debug — the same map as /map, mirroring the parent's debug path.
 *
 * The parent serves a debug variant of every map view, so the child names one
 * too and the two tiers stay spellable by the same table. There is nothing to
 * switch on yet: OnlineMapPage takes no rails prop, so this renders the same
 * view rather than pretending to a debug mode it does not have. When the
 * child grows one, it goes here and the URL already exists. (It does take
 * `debugHost`, the dev-tray hand-off — wired below, same as /map.)
 */
import OnlineMapPage from "../../../lib/OnlineMapPage.svelte";
// DEV CHROME GOES TO THE SAME SURFACE ON EVERY TIER. The child's read-out is
// handed to the shared EphemeralCard (tray) via `debugHost`; the card lives in
// `$rig/…` and renders only in `vite dev`, so nothing here
// reaches a build. No docks: the online map has no rails to dock.

let debugHost = $state<HTMLElement>();
</script>

<OnlineMapPage {debugHost} />
