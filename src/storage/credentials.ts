import type { ProviderId } from '../types/contracts';
import { restrictStorage } from './settings';

const slot = (provider: ProviderId) => `credential:${provider}`;
const savedString = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;

export async function credential(provider: ProviderId): Promise<{ key?: string; remembered: boolean }> {
  if (provider === 'chrome') return { remembered: false };
  await restrictStorage();
  const id = slot(provider);
  const transient = savedString((await chrome.storage.session.get(id))[id]);
  if (transient) return { key: transient, remembered: false };
  const persistent = savedString((await chrome.storage.local.get(id))[id]);
  return { key: persistent, remembered: !!persistent };
}

const mutations = new Map<ProviderId, Promise<void>>();
export function saveCredential(provider: ProviderId, replacement: string | undefined, remember: boolean): Promise<void> {
  const previous = mutations.get(provider) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    if (provider === 'chrome') return;
    const value = replacement === undefined ? (await credential(provider)).key : replacement.trim();
    const id = slot(provider);
    if (!value) {
      await chrome.storage.local.remove(id);
      await chrome.storage.session.remove(id);
    } else if (remember) {
      await chrome.storage.local.set({ [id]: value });
      await chrome.storage.session.remove(id);
    } else {
      await chrome.storage.session.set({ [id]: value });
      await chrome.storage.local.remove(id);
    }
  });
  mutations.set(provider, task);
  return task.finally(() => { if (mutations.get(provider) === task) mutations.delete(provider); });
}
