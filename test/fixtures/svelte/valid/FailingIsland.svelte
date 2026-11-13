<!-- Test-only island whose first effect throws after its DOM is created. -->
<script lang="ts">
    let ready: boolean = $state(false);
    $effect(() => {
        if (!ready) throw new Error('fixture effect failed');
    });
</script>

<p class="bpb-failing-island">Failing island</p>
