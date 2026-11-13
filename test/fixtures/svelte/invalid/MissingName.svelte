<!-- Intentional failure: the template names a binding that does not exist. -->
<script lang="ts">
    let count: number = $state(0);
</script>

<button onclick={() => count++}>{coutn}</button>
