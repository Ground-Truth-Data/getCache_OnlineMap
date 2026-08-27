<script lang="ts">
/**
 * /map — the online map, running on nothing.
 *
 * SAME PATH AS THE MOUNTING PARENT SERVES. The tier pill translates a path to
 * its counterpart on the other tier, and when both tiers spell a view the same
 * way that translation is the identity — nothing to write down, nothing to get
 * wrong. This child previously served only /demo, a name the parent has no
 * route for, so the pill had no counterpart to offer and greyed out.
 *
 * NOTE this is not ReTreever's real /map. That one is MobMapPage.svelte, which
 * reaches into mapStore and the mobile component tree — tier-1 proprietary
 * code a child must never carry. This is the fixture-backed view: honest about
 * being a demo, and it runs with no parent behind it.
 */
import MapPage from "../../lib/mapPage.svelte";
</script>

<MapPage variant="org" />
