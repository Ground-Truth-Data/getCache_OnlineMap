<script lang="ts">
/**
 * /map/debug — the same map as /map, mirroring the parent's debug path.
 *
 * The parent serves a debug variant of every map view, so the child names one
 * too and the two tiers stay spellable by the same table. There is nothing to
 * switch on yet: `mapPage.svelte` takes no rails prop, so this renders the
 * same view rather than pretending to a debug mode it does not have. When the
 * child grows one, it goes here and the URL already exists.
 */
import MapPage from "../../../lib/mapPage.svelte";
</script>

<MapPage variant="org" />
