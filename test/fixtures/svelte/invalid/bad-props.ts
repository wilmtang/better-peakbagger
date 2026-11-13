// Intentional failure: the island's props are type-checked at the mount site.
import { mount } from 'svelte';
import UnitsIsland from '../valid/UnitsIsland.svelte';

mount(UnitsIsland, { target: document.body, props: { settings: 42, onSave: () => {} } });
