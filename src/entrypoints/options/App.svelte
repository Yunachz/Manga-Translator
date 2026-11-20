<script lang="ts">
  import { onMount } from 'svelte';
  import { providerOrigin, providers } from '../../core/translation/catalog';
  import { nativeTranslator, prepareChromeTranslator } from '../../core/translation/ChromeTranslatorProvider';
  import { copy, defaultUiLanguage, languageLabel, uiLanguageNames, uiLanguages, type UiLanguage } from '../../i18n/messages';
  import InpaintingSelect from '../../ui/InpaintingSelect.svelte';
  import { localizedError } from '../../i18n/errors';
  import { hostPattern } from '../../messaging/permission';
  import { uiRequest } from '../../messaging/protocol';
  import { sourceLanguages, type ProviderId, type Settings } from '../../types/contracts';
  import LanguageFields from '../../ui/LanguageFields.svelte';
  import ProviderSelect from '../../ui/ProviderSelect.svelte';

  let settings = $state<Settings>();
  let chromeAvailable = $state(false);
  let savedLanguages = $state<Pick<Settings, "source" | "target">>({ source: "auto", target: "id" });
  let apiField = $state<HTMLInputElement>();
  let remember = $state(false);
  let hasKey = $state(false);
  let hasPermission = $state(false);
  let busy = $state(false);
  let status = $state('');
  let feedbackKind = $state<'neutral' | 'good' | 'error'>('neutral');
  const locale = $derived(settings?.uiLanguage ?? defaultUiLanguage);
  const t = $derived(copy(locale));
  $effect(() => { document.documentElement.lang = locale; });
  const current = $derived(settings?.provider ?? 'chrome');
  const cloud = $derived(current !== 'chrome');
  const llm = $derived(providers[current].type === 'llm');
  const origin = $derived(settings ? providerOrigin(current, settings.providers[current]) : '');

  $effect(() => {
    if (apiField) apiField.value = '';
    if (cloud) void refreshProvider(current, origin);
    else { hasKey = false; remember = false; hasPermission = false; }
  });

  onMount(() => {
    void uiRequest<Settings>({ type: 'GET_SETTINGS' }).then(result => {
      settings = result;
      savedLanguages = { source: result.source, target: result.target };
    }).catch(failed);
    void uiRequest<boolean>({ type: 'GET_CHROME' }).then(result => {
      chromeAvailable = result && !!nativeTranslator();
    }).catch(() => undefined);
  });

  function show(text: string, kind: typeof feedbackKind = 'neutral') { status = text; feedbackKind = kind; }
  function failed(error: unknown) { show(error instanceof Error ? localizedError(locale, error.message) : t.settingsFailed, 'error'); }

  async function changeUiLanguage(value: UiLanguage) {
    if (!settings || settings.uiLanguage === value) return;
    const previous = settings.uiLanguage;
    settings.uiLanguage = value;
    try {
      await uiRequest<Settings>({ type: 'SET_SETTINGS', patch: { uiLanguage: value } });
      show('');
    } catch (error) {
      if (settings.uiLanguage === value) settings.uiLanguage = previous;
      failed(error);
    }
  }

  async function refreshProvider(provider: ProviderId, endpoint: string) {
    try {
      const [key, permission] = await Promise.all([
        uiRequest<{ present: boolean; remembered: boolean }>({ type: 'GET_CREDENTIAL', provider }),
        chrome.permissions.contains({ origins: [hostPattern(endpoint)] }),
      ]);
      if (settings?.provider !== provider || origin !== endpoint) return;
      hasKey = key.present; remember = key.remembered; hasPermission = permission;
    } catch (error) { failed(error); }
  }

  async function permit() {
    if (!origin) return;
    try {
      hasPermission = await chrome.permissions.request({ origins: [hostPattern(origin)] });
      show(hasPermission ? t.providerGranted : t.providerDenied, hasPermission ? 'good' : 'error');
    } catch (error) { failed(error); }
  }

  async function persist() {
    if (!settings || busy) return;
    const snapshot = $state.snapshot(settings);
    const key = apiField?.value.trim() || undefined;
    const persistent = remember;
    busy = true;
    show(t.saving);
    try {
      settings = await uiRequest<Settings>({ type: 'SET_SETTINGS', patch: snapshot });
      savedLanguages = { source: settings.source, target: settings.target };
      if (snapshot.provider !== 'chrome') {
        const saved = await uiRequest<{ present: boolean; remembered: boolean }>({
          type: 'SET_CREDENTIAL', provider: snapshot.provider, key, remember: persistent,
        });
        if (apiField) apiField.value = '';
        hasKey = saved.present;
        remember = saved.remembered;
      }
      show(t.saved, 'good');
    } catch (error) { failed(error); }
    finally { busy = false; }
  }

  async function removeKey() {
    if (!settings || busy) return;
    try {
      await uiRequest({ type: 'SET_CREDENTIAL', provider: current, key: '', remember: false });
      hasKey = remember = false;
      if (apiField) apiField.value = '';
      show(t.keyRemoved, 'good');
    } catch (error) { failed(error); }
  }

  async function test() {
    if (!settings || busy) return;
    busy = true;
    show(t.testing);
    try {
      if (current === 'chrome') {
        const { source, target } = savedLanguages;
        const sample = source === 'auto' || source === target ? target === 'en' ? 'ja' : 'en' : source;
        await prepareChromeTranslator({ sourceLanguage: sample, targetLanguage: target });
      }
      await uiRequest({ type: 'TEST_PROVIDER', provider: current });
      show(t.testPassed, 'good');
    } catch (error) { failed(error); }
    finally { busy = false; }
  }
</script>

<main class="page" data-ui>
  <header class="brand"><img class="mark" src="/icon/48.png" width="24" height="24" alt="" /><span>Manga Translator</span></header>
  <h1>{t.settings}</h1>
  {#if settings}
    <fieldset disabled={busy}>
      <section aria-labelledby="appearance">
        <div class="section-label"><h2 id="appearance">{t.appearance}</h2></div>
        <div class="section-fields">
          <label class="field">{t.interfaceLanguage}
            <select value={locale} onchange={event => void changeUiLanguage(event.currentTarget.value as UiLanguage)}>
              {#each uiLanguages as language (language)}<option value={language} lang={language}>{uiLanguageNames[language]}</option>{/each}
            </select>
          </label>
        </div>
      </section>
      <section aria-labelledby="provider">
        <div class="section-label"><h2 id="provider">{t.translation}</h2><p class="help">{t.cloudExplanation}</p></div>
        <div class="section-fields">
          <ProviderSelect bind:value={settings.provider} {chromeAvailable} {locale} />
          <LanguageFields bind:source={settings.source} bind:target={settings.target} {locale} />
          {#if cloud}
            <label class="field">{t.apiKey}
              <input type="password" bind:this={apiField} autocomplete="new-password" spellcheck="false"
                aria-label={t.apiKey} placeholder={hasKey ? t.savedKey : t.enterKey} aria-describedby="key-help">
              <small id="key-help">{t.sessionKeyHelp}</small>
            </label>
            <label class="check"><input type="checkbox" bind:checked={remember}> {t.rememberKey}</label>
            {#if remember}<p class="help">{t.storedKeyHelp}</p>{/if}
            {#if llm}<label class="field">Model
              <input bind:value={settings.providers[current].model} placeholder={providers[current].model} maxlength="100" spellcheck="false">
            </label>{/if}
            {#if current === 'deepl'}<label class="field">{t.deeplPlan}
              <select bind:value={settings.providers.deepl.endpointTier}><option value="free">API Free</option><option value="pro">API Pro</option></select>
            </label>{/if}
            {#if current === 'azure'}<label class="field">{t.azureRegion}
              <input bind:value={settings.providers.azure.region} placeholder={t.azureExample} maxlength="50" spellcheck="false">
              <small>{t.azureHelp}</small>
            </label>{/if}
            <div class="row">
              <button type="button" class="button" onclick={permit} disabled={hasPermission}>{hasPermission ? t.permissionGranted : t.allowProvider}</button>
              <button type="button" class="button" onclick={removeKey} disabled={!hasKey}>{t.removeKey}</button>
            </div>
          {:else}
            <p class="help">{chromeAvailable ? t.chromeAvailable : t.chromeUnavailable}</p>
          {/if}
          <div class="row">
            <button type="button" class="button" onclick={test} disabled={cloud ? !hasKey || !hasPermission : !chromeAvailable}>{t.testConnection}</button>
            <small class="help">{t.testHelp}</small>
          </div>
        </div>
      </section>

      <section aria-labelledby="ocr">
        <div class="section-label"><h2 id="ocr">{t.localProcessing}</h2><p class="help">{t.ocrOnDevice}</p></div>
        <div class="section-fields">
          <div class="pairs">
            <label class="field">{t.ocrLanguage}<select bind:value={settings.ocrLanguage}>
              {#each sourceLanguages as id (id)}<option value={id}>{languageLabel(locale, id)}</option>{/each}
            </select></label>
            <label class="field">{t.readingOrder}<select bind:value={settings.readingOrder}>
              <option value="auto">{t.auto}</option><option value="rtl">{t.rightToLeft}</option><option value="ttb">{t.topToBottom}</option>
            </select></label>
            <label class="field">Runtime<select bind:value={settings.performance}>
              <option value="auto">{t.webgpuFallback}</option><option value="wasm">WASM</option>
            </select></label>
            <label class="field">{t.inpaintingMethod}<select bind:value={settings.inpainting}>
              <option value="auto">{t.adaptive}</option><option value="fast">{t.solidFill}</option><option value="classical">{t.classical}</option>
            </select></label>
          </div>
          <InpaintingSelect bind:value={settings.inpaintingMode} {locale} />
          <label class="check"><input type="checkbox" bind:checked={settings.prefetch}> {t.prefetch}</label>
        </div>
      </section>
      <details>
        <summary>{t.advanced}</summary>
        {#if llm}
          <div class="extra">
            <h2>{t.dialogueContext}</h2>
            <label class="check"><input type="checkbox" bind:checked={settings.contextual}> {t.usePanelContext}</label>
            <label class="check"><input type="checkbox" bind:checked={settings.usePreviousPanel} disabled={!settings.contextual}> {t.usePreviousPanel}</label>
            <label class="field">{t.seriesTitle}<input bind:value={settings.series} maxlength="140" disabled={!settings.contextual}></label>
            <label class="field">{t.glossary}<textarea bind:value={settings.glossary} maxlength="3000" placeholder={t.glossaryExample} disabled={!settings.contextual}></textarea>
              <small>{t.glossaryHelp}</small>
            </label>
          </div>
        {/if}
        <div class="extra">
          <h2>Typesetting</h2>
          <div class="pairs">
            <label class="field">Font<select bind:value={settings.fontFamily}>
              <option value="Arial">Arial</option><option value="Verdana">Verdana</option><option value="Georgia">Georgia</option>
            </select></label>
            <label class="field">{t.fontWeight}<select bind:value={settings.fontWeight}>
              <option value={400}>Regular</option><option value={600}>Semibold</option><option value={700}>Bold</option>
            </select></label>
            <label class="field">{t.bubblePadding}<input type="number" bind:value={settings.padding} min="0.02" max="0.24" step="0.01"></label>
            <label class="field">{t.lineHeight}<input type="number" bind:value={settings.lineHeight} min="1" max="1.55" step="0.01"></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={settings.debug}> {t.debugPanels}</label>
          <div class="row"><button type="button" class="button" onclick={() => {
            void uiRequest({ type: 'CLEAR_CACHE' }).then(() => show(t.cacheCleared, 'good')).catch(failed);
          }}>{t.clearCache}</button></div>
        </div>
      </details>
      <footer class="row">
        <button type="button" class="button primary" onclick={persist}>{t.saveSettings}</button>
        <p class={`status ${feedbackKind}`} role="status">{status}</p>
      </footer>
    </fieldset>
  {:else}
    <p class={`status ${feedbackKind}`} role="status">{status || t.loadingSettings}</p>
  {/if}
</main>

<style>
  .page { max-width: 960px; margin-inline: auto; padding: 28px 28px 48px; }
  header { min-height: 32px; font-weight: 650; margin-bottom: 24px; }
  h1 { font-size: 32px; margin-bottom: 24px; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  section { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(0, 2.1fr); gap: 28px; padding: 24px 0; border-top: 1px solid var(--rule); }
  .section-label { display: grid; align-content: start; gap: 8px; }
  .section-fields, .extra { display: grid; gap: 14px; min-width: 0; }
  .pairs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  details { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); padding: 18px 0; }
  summary { cursor: pointer; font-weight: 610; }
  .extra { padding: 14px 0 7px; }
  footer { padding-top: 20px; gap: 16px; }
  @media (max-width: 575px) { section { grid-template-columns: 1fr; gap: 9px; } }
  @media (max-width: 345px) { .page { padding-inline: 16px; } .pairs { grid-template-columns: 1fr; } }
</style>
