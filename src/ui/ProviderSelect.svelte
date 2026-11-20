<script lang="ts">
  import { providers } from '../core/translation/catalog';
  import { copy, type UiLanguage } from '../i18n/messages';
  import { providerIds, type ProviderId } from '../types/contracts';

  let { value = $bindable(), chromeAvailable, locale, disabled = false, onchange }:
    { value: ProviderId; chromeAvailable: boolean; locale: UiLanguage; disabled?: boolean; onchange?: () => void } = $props();
</script>

<label class="field">
  {copy(locale).provider}
  <select value={value === 'chrome' && !chromeAvailable ? '' : value} {disabled}
    onchange={event => { value = event.currentTarget.value as ProviderId; onchange?.(); }}>
    {#if value === 'chrome' && !chromeAvailable}<option value="" disabled>{copy(locale).chooseProvider}</option>{/if}
    {#each providerIds as id (id)}
      {#if id !== 'chrome' || chromeAvailable}<option value={id}>{providers[id].name}</option>{/if}
    {/each}
  </select>
</label>
