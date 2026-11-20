<script lang="ts">
  import { targetLanguages } from '../core/translation/catalog';
  import { copy, languageLabel, type UiLanguage } from '../i18n/messages';
  import { sourceLanguages, type SourceLanguage } from '../types/contracts';

  let { source = $bindable(), target = $bindable(), locale, disabled = false, onchange }:
    { source: SourceLanguage; target: string; locale: UiLanguage; disabled?: boolean; onchange?: () => void } = $props();
</script>

<div class="languages">
  <label class="field">{copy(locale).sourceLanguage}
    <select bind:value={source} {disabled} {onchange}>
      {#each sourceLanguages as id (id)}<option value={id}>{languageLabel(locale, id)}</option>{/each}
    </select>
  </label>
  <label class="field">{copy(locale).targetLanguage}
    <select bind:value={target} {disabled} {onchange}>
      {#each targetLanguages as [id] (id)}<option value={id}>{languageLabel(locale, id)}</option>{/each}
    </select>
  </label>
</div>

<style>
  .languages { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
</style>
