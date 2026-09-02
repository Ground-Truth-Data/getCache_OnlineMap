<script lang="ts">
import { dev } from "$app/environment";
/**
 * THE ONLINE MAP'S OWN DEMO — the org globe.
 *
 * Relative, not $parent/siblings: the path stays correct when this child is lifted into
 * its own repo. The shell's src/routes/who/map/+page.svelte is a two-line
 * mount naming the URL this answers on.
 */
import MapPage from "../../lib/mapPage.svelte";
// DEV CHROME GOES TO THE SAME SURFACE ON EVERY TIER. The child's read-out is
// handed to the shared EphemeralCard (tray) via `debugHost`; the card lives in
// `$rig/…` and renders only in `vite dev`, so nothing here
// reaches a build. No docks: the online map has no rails to dock.
import EphemeralCard from "$rig/dev/EphemeralCard.svelte";
import EphemeralDock from "$rig/dev/EphemeralDock.svelte";

let debugHost = $state<HTMLElement>();
</script>

<MapPage variant="org" {debugHost} />
<!-- Gated at the CALL SITE, not only inside the dock. EphemeralDock and
     EphemeralCard each carry their own `{#if dev}`, which stops them
     rendering but cannot stop them shipping: an unconditional mount is a
     live reference the bundler must keep, so the dev card and devCard.css
     travelled into production builds. A component gating itself can never
     delete its own call site — only the caller can. -->
{#if dev}
	<EphemeralDock side="left"><EphemeralCard title="online map" bind:host={debugHost} /></EphemeralDock>
{/if}
