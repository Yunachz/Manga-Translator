import { mount } from 'svelte';
import '../../ui/extension.css';
import App from './App.svelte';

// Native toolbar popups size themselves to intrinsic content. A normal tab can reflow to its viewport.
void chrome.tabs.getCurrent().then(tab => {
  if (tab) delete document.documentElement.dataset.popupMode;
}).catch(() => undefined);

mount(App, { target: document.getElementById('app')! });
