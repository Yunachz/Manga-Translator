import { mount } from 'svelte';
import '../../ui/extension.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
