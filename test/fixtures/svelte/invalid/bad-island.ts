// Intentional failures: the island adapter checks props at mount and on update.
import { mountIsland } from '../../../../src/ui/svelte-island.ts';
import UnitsIsland from '../valid/UnitsIsland.svelte';

const island = mountIsland(UnitsIsland, { target: document.body, props: { settings: 'metric', onSave: () => {} } });
island.update({ settings: 7 });
