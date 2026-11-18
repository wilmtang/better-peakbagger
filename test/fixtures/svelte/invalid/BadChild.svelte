<!-- Intentional failure: a child component receives a prop of the wrong type. -->
<script lang="ts">
    import UnitsIsland from '../valid/UnitsIsland.svelte';
</script>

<UnitsIsland settings="metric" onSave={() => {}} />
