<!-- Copyright (C) 2026 wilmtang <wilm.tang@outlook.com> -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
    interface ModelOption {
        readonly id: string;
        readonly label: string;
        readonly gridKm: number;
        readonly days: number;
    }

    interface DateOption {
        readonly value: string;
        readonly label: string;
    }

    interface Props {
        readonly models: readonly ModelOption[];
        readonly selection: string;
        readonly unavailableLabel: string | null;
        readonly dates: readonly DateOption[];
        readonly requestedDate: string;
        readonly blocked: boolean;
        readonly pending: boolean;
        readonly onModelChange: (value: string) => void;
        readonly onDateChange: (value: string) => void;
        readonly onRefresh: () => void;
    }

    const {
        models,
        selection,
        unavailableLabel,
        dates,
        requestedDate,
        blocked,
        pending,
        onModelChange,
        onDateChange,
        onRefresh,
    }: Props = $props();

    let modelSelect: HTMLSelectElement | undefined;
    let dateSelect: HTMLSelectElement | undefined;

    // Option-list updates recreate or reorder <option> nodes, so keep the
    // DOM property aligned after each update rather than relying on initial bind.
    $effect(() => {
        void models;
        void unavailableLabel;
        if (modelSelect && selection) modelSelect.value = selection;
    });

    $effect(() => {
        void dates;
        if (dateSelect && requestedDate) dateSelect.value = requestedDate;
    });

    // Attach listeners directly on each control because callers and host
    // scripts dispatch non-bubbling Event('change') or stop bubbling.
    const listen = (eventName: string, handler: (event: Event) => void) => (node: HTMLElement) => {
        node.addEventListener(eventName, handler);
        return () => node.removeEventListener(eventName, handler);
    };

    const handleModelChange = (event: Event) => {
        const control = event.currentTarget as HTMLSelectElement;
        if (blocked) {
            control.value = selection;
            return;
        }
        onModelChange(control.value);
    };

    const handleDateChange = (event: Event) => {
        const control = event.currentTarget as HTMLSelectElement;
        if (blocked) {
            control.value = requestedDate;
            return;
        }
        onDateChange(control.value);
    };

    const handleRefreshClick = () => {
        if (!pending && !blocked) onRefresh();
    };
</script>

<label class="bpb-cloud-control" for="bpb-summit-cloud-model">
    <span>Model</span>
    <select
        id="bpb-summit-cloud-model"
        form=""
        aria-disabled={blocked}
        value={selection}
        bind:this={modelSelect}
        {@attach listen('change', handleModelChange)}
    >
        <option value="auto">Automatic · compare models</option>
        {#each models as model (model.id)}
            <option value={model.id}>{model.label} · {model.gridKm} km · up to {model.days} days</option>
        {/each}
        {#if unavailableLabel}
            <option value={selection} disabled>{unavailableLabel}</option>
        {/if}
    </select>
</label>
<label class="bpb-cloud-control" for="bpb-summit-cloud-date">
    <span>Date</span>
    <select
        id="bpb-summit-cloud-date"
        form=""
        aria-disabled={blocked}
        value={requestedDate}
        bind:this={dateSelect}
        {@attach listen('change', handleDateChange)}
    >
        {#each dates as date (date.value)}
            <option value={date.value}>{date.label}</option>
        {/each}
    </select>
</label>
<button
    type="button"
    class="bpb-cloud-refresh"
    aria-label="Refresh summit cloud forecast"
    aria-disabled={pending || blocked}
    {@attach listen('click', handleRefreshClick)}
>Refresh</button>
