<script lang="ts">
import { dev } from "$app/environment";
/**
 * /map — the URL; the page is ../../lib/OnlineMapPage.svelte.
 *
 * A route file is just a mount — keep the logic in the component; two copies
 * of the wiring drift the first time either is touched. Same path as the
 * mounting parent serves, so the tier pill's translation is the identity.
 *
 * No ports here: a solo checkout has no host store, so the map renders with
 * no pins rather than crashing — the ports contract's whole point.
 */
import OnlineMapPage from "../../lib/OnlineMapPage.svelte";
// DEV CHROME GOES TO THE SAME SURFACE ON EVERY TIER. The child's read-out is
// handed to the shared EphemeralCard (tray) via `debugHost`; the card lives in
// `$rig/…` and renders only in `vite dev`, so nothing here
// reaches a build. No docks: the online map has no rails to dock.
import EphemeralCard from "$rig/dev/EphemeralCard.svelte";
import EphemeralDock from "$rig/dev/EphemeralDock.svelte";

let debugHost = $state<HTMLElement>();
</script>

<OnlineMapPage {debugHost} />
<!-- Gated at the CALL SITE, not only inside the dock. EphemeralDock and
     EphemeralCard each carry their own `{#if dev}`, which stops them
     rendering but cannot stop them shipping: an unconditional mount is a
     live reference the bundler must keep, so the dev card and devCard.css
     travelled into production builds. A component gating itself can never
     delete its own call site — only the caller can. -->
{#if dev}
	<EphemeralDock side="left"><EphemeralCard title="online map" bind:host={debugHost} /></EphemeralDock>
{/if}
