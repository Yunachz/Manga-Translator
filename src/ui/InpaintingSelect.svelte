<script lang="ts">
  import { copy, type UiLanguage } from '../i18n/messages';
  import { inpaintingModes, type InpaintingMode } from '../types/contracts';

  let { value = $bindable(), locale, onchange }: {
    value: InpaintingMode;
    locale: UiLanguage;
    onchange?: (mode: InpaintingMode) => void;
  } = $props();
  const t = $derived(copy(locale));
  const labels = $derived({ normal: t.inpaintingNormal, constrained: t.inpaintingConstrained,
    conservative: t.inpaintingConservative });
  const help = $derived({ normal: t.inpaintingNormalHelp, constrained: t.inpaintingConstrainedHelp,
    conservative: t.inpaintingConservativeHelp });
  const helpId = $props.id();
</script>

<div class="field">
  <label class="field">{t.inpaintingMode}
    <select {value} aria-describedby={helpId}
      onchange={event => {
        value = event.currentTarget.value as InpaintingMode;
        onchange?.(value);
      }}>
      {#each inpaintingModes as mode (mode)}<option value={mode}>{labels[mode]}</option>{/each}
    </select>
  </label>
  <small id={helpId} class="help">{help[value]}</small>
</div>
