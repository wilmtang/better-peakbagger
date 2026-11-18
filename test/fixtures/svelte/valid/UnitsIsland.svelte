<!-- Test-only island: proves compile, mount, update and dispose; not shipped. -->
<script lang="ts">
    import { unitSettingsPatch, type UnitDefault, type UnitSettings, type UnitSettingsPatch } from '../../../../options/unit-settings-contract.ts';
    import { createUnitsDraft } from './units-draft.svelte.ts';

    interface Props {
        settings: UnitSettings;
        onSave: (patch: UnitSettingsPatch, draft: object) => void;
    }
    let { settings, onSave }: Props = $props();
    const draft = createUnitsDraft(() => settings);

    const choose = (event: Event & { currentTarget: HTMLSelectElement }) => {
        draft.state.units = event.currentTarget.value as UnitDefault;
        draft.state.history.edits++;
        onSave(unitSettingsPatch(draft.state), draft.state);
    };
</script>

<section class="bpb-units-island" data-units={draft.state.units}>
    <label>
        Default units
        <select value={draft.state.units} onchange={choose}>
            <option value="auto">Peakbagger</option>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
        </select>
    </label>
    <output>{draft.customCount} custom</output>
</section>

<style>
    .bpb-units-island { display: flex; gap: 8px; align-items: center; }
</style>
