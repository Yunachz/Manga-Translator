<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { activeChapter, canRetryChapter, chapterStatusLabel, chapterSummary, type ChapterCommand } from '../../core/chapter/ChapterRun';
  import { copy, defaultUiLanguage, format } from '../../i18n/messages';
  import InpaintingSelect from '../../ui/InpaintingSelect.svelte';
  import { localizedError } from '../../i18n/errors';
  import { hostPattern } from '../../messaging/permission';
  import { record } from '../../messaging/validate';
  import { uiRequest, type TabStatus, type VisiblePagesStatus } from '../../messaging/protocol';
  import type { Settings } from '../../types/contracts';
  import ProviderSelect from '../../ui/ProviderSelect.svelte';
  import LanguageFields from '../../ui/LanguageFields.svelte';

  let settings = $state<Settings>();
  let tab = $state<TabStatus>({ active: false });
  let tabId = $state<number>();
  let chromeAvailable = $state(false);
  let busy = $state(false);
  let error = $state('');
  let preview = $state(false);
  let previewSummary = $state<HTMLParagraphElement>();
  let reviewButton = $state<HTMLButtonElement>();
  let chapterHeading = $state<HTMLHeadingElement>();
  let cleared = $state(false);
  let allowedChapterOrigin = $state<string>();
  let panelPermissionGranted = $state(false);
  let permissionError = $state('');
  let requestingPermission = $state(false);
  let tabLoaded = $state(false);
  let latestRefresh = 0;
  let chapterOrigin = $derived(tab.chapter?.pendingOrigin);
  let needsChapterPermission = $derived(!!chapterOrigin && chapterOrigin !== allowedChapterOrigin);
  const locale = $derived(settings?.uiLanguage ?? defaultUiLanguage);
  const t = $derived(copy(locale));
  $effect(() => { document.documentElement.lang = locale; });
  let inProgress = $derived(!!tab.chapter && activeChapter(tab.chapter.phase));
  let visibleRun = $derived(tab.visiblePages?.run);
  let visibleRunning = $derived(visibleRun?.phase === 'running');
  $effect(() => {
    if (!visibleRunning) return;
    const timer = setInterval(() => { void refresh().catch(failed); }, 1000);
    return () => clearInterval(timer);
  });

  function visibleLabel(run: VisiblePagesStatus): string {
    if (run.phase === 'finished' && !run.total) return t.visibleNone;
    const headline = run.phase === 'running' ? t.visibleProgress : run.phase === 'stopped' ? t.visibleStopped : t.visibleFinished;
    return format(headline, { done: run.processed, total: run.total });
  }

  async function refresh() {
    const id = tabId;
    if (id === undefined) return;
    const request = ++latestRefresh;
    const status = await uiRequest<TabStatus>({ type: 'GET_TAB', tabId: id });
    const origin = status.chapter?.pendingOrigin;
    const allowed = origin && await chrome.permissions.contains({ origins: [hostPattern(origin)] });
    if (request !== latestRefresh) return;
    tab = status;
    allowedChapterOrigin = allowed ? origin : undefined;
    tabLoaded = true;
  }

  onMount(() => {
    const recheck = () => { void refresh().catch(failed); };
    const onStatusChanged = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('background.js') &&
        record(message) && message.to === 'popup' && message.type === 'TAB_STATUS_CHANGED' && message.tabId === tabId) recheck();
    };
    chrome.runtime.onMessage.addListener(onStatusChanged);
    chrome.permissions.onAdded.addListener(recheck);
    chrome.permissions.onRemoved.addListener(recheck);
    void Promise.all([uiRequest<Settings>({ type: 'GET_SETTINGS' }), chrome.tabs.query({ active: true, currentWindow: true })])
      .then(async ([config, [current]]) => {
        settings = config;
        tabId = current?.id;
        if (tabId === undefined) tabLoaded = true;
        else await refresh();
      }).catch(failed);
    void uiRequest<boolean>({ type: 'GET_CHROME' }).then(value => { chromeAvailable = value; }).catch(() => undefined);
    return () => {
      chrome.runtime.onMessage.removeListener(onStatusChanged);
      chrome.permissions.onAdded.removeListener(recheck);
      chrome.permissions.onRemoved.removeListener(recheck);
    };
  });

  function failed(reason: unknown) {
    error = localizedError(locale, reason instanceof Error ? reason.message : 'Extension tidak merespons.');
  }

  async function save(changes: Partial<Settings>) {
    error = '';
    if (changes.enabled === false) preview = false;
    try {
      settings = await uiRequest<Settings>({ type: 'SET_SETTINGS', patch: changes });
      await refresh();
    } catch (reason) { failed(reason); }
  }

  function saveLanguages() {
    if (settings) void save({ source: settings.source, target: settings.target });
  }

  async function toggleTranslation() {
    if (tabId === undefined || busy) return;
    busy = true;
    error = '';
    try {
      await uiRequest<TabStatus>({ type: 'SET_TAB', tabId, active: !tab.active });
      await refresh();
    }
    catch (reason) { failed(reason); }
    finally { busy = false; }
  }

  async function reviewChapter(open: boolean) {
    if (busy || (open && !settings?.enabled)) return;
    preview = open;
    await tick();
    (open ? previewSummary : reviewButton)?.focus();
  }

  async function chapterCommand(command: ChapterCommand) {
    if (tabId === undefined || busy || !settings?.enabled ||
      (command === 'resume' && !!chapterOrigin)) return;
    busy = true;
    error = '';
    cleared = false;
    permissionError = '';
    try {
      await uiRequest({ type: 'CHAPTER_CONTROL', tabId, command });
      if (command === 'start') preview = false;
      await refresh();
      if (command === 'start' || command === 'stop' || command === 'retry') {
        await tick();
        chapterHeading?.focus();
      }
    } catch (reason) { failed(reason); }
    finally { busy = false; }
  }

  async function visibleCommand(command: 'start' | 'stop') {
    if (tabId === undefined || busy || !settings?.enabled) return;
    busy = true;
    error = '';
    cleared = false;
    try {
      await uiRequest({ type: 'VISIBLE_PAGES', tabId, command });
      await refresh();
    } catch (reason) { failed(reason); }
    finally { busy = false; }
  }

  async function clearTranslations() {
    if (tabId === undefined || !tab.readerReady || busy) return;
    busy = true;
    error = '';
    preview = false;
    try {
      await uiRequest({ type: 'CLEAR_TRANSLATIONS', tabId });
      panelPermissionGranted = false;
      await refresh();
      cleared = true;
    } catch (reason) { failed(reason); }
    finally { busy = false; }
  }

  async function permitImage(origin: string, chapter: boolean) {
    if (requestingPermission) return;
    requestingPermission = true;
    permissionError = '';
    try {
      const granted = await chrome.permissions.request({ origins: [hostPattern(origin)] });
      if (!granted) {
        permissionError = t.permissionDenied;
        return;
      }
      if (chapter && tabId !== undefined) await uiRequest({ type: 'RESUME_AFTER_PERMISSION', tabId });
      else panelPermissionGranted = true;
      await refresh();
      if (chapter) {
        await tick();
        chapterHeading?.focus();
      }
    } catch {
      permissionError = t.permissionRequestFailed;
    } finally { requestingPermission = false; }
  }
</script>

<svelte:window onkeydown={event => {
  if (event.key === 'Escape' && preview && !busy) {
    event.preventDefault();
    void reviewChapter(false);
  }
}} />

<main class="popup" data-ui>
  <header>
    <div class="brand"><img class="mark" src="/icon/48.png" width="24" height="24" alt="" /><h1>Manga Translator</h1></div>
    <button class="button link" onclick={() => chrome.runtime.openOptionsPage()}>{t.settings}</button>
  </header>

  {#if settings}
    <div class="mode">
      <label class="check"><input type="checkbox" checked={settings.enabled}
        onchange={event => void save({ enabled: event.currentTarget.checked })}> {t.enabled}</label>
      <div class="mode-body">
        <span class="mode-label">{t.clickPanel}</span>
        <p class:ready={tab.active}>{tab.active ? t.activeTab : t.inactive}</p>
        <button class="button primary" onclick={toggleTranslation} disabled={!settings.enabled || busy || tabId === undefined}>
          {tab.active ? t.deactivate : t.activate}
        </button>
      </div>
    </div>
    {#if tab.visiblePages}
      <section class="chapter" aria-labelledby="visible-title" aria-busy={busy}>
        <h2 id="visible-title">{t.translateVisible}</h2>
        {#if visibleRun && visibleRun.phase !== 'idle'}
          <p class="chapter-status" role="status">{visibleLabel(visibleRun)}</p>
          {#if visibleRun.total > 0}<progress aria-label={t.pagesProcessed} value={visibleRun.processed} max={visibleRun.total}></progress>{/if}
          {#if visibleRun.processed > 0}<p class="help">{format(t.visibleCounts, { translated: visibleRun.translated, skipped: visibleRun.skipped, failed: visibleRun.failed })}</p>{/if}
          {#if visibleRun.captured > 0}<p class="help">{t.visibleCaptureNote}</p>{/if}
        {:else}
          <p class="help">{t.visibleScope}</p>
          <p class="help">{format(t.pagesOnScreen, { count: tab.visiblePages.visiblePages })}</p>
        {/if}
        {#if settings.provider !== 'chrome' && !visibleRunning}<p class="help">{t.cloudQuota}</p>{/if}
        <div class="chapter-actions">
          {#if visibleRunning}
            <button class="button" onclick={() => visibleCommand('stop')} disabled={busy}>{t.stopVisible}</button>
          {:else}
            <button class="button primary" aria-disabled={!settings.enabled || busy} onclick={() => visibleCommand('start')}>{t.translateVisible}</button>
          {/if}
        </div>
        {#if !settings.enabled}<p class="help">{t.enableChapter}</p>{/if}
      </section>
    {:else if tab.chapterAvailable}
      <section class="chapter" aria-labelledby="chapter-title" aria-busy={busy}>
        <h2 id="chapter-title" bind:this={chapterHeading} tabindex="-1">{tab.chapterScope === "mounted" ? t.translateLoaded : t.translateChapter}</h2>
        {#if tab.chapter}
          <p class="chapter-status" role="status">{chapterStatusLabel(tab.chapter, locale)}{tab.chapter.total === null ? '' : ` · ${tab.chapter.processed}/${tab.chapter.total} ${t.pages}`}</p>
          {#if tab.chapter.total !== null && tab.chapter.total > 0}
            <progress aria-label={t.pagesProcessed} value={tab.chapter.processed} max={tab.chapter.total}></progress>
          {/if}
          {#if tab.chapter.processed > 0}
            <p class="help">{chapterSummary(tab.chapter, locale)}</p>
          {/if}
          {#if chapterOrigin}
            {#if needsChapterPermission}
              <p class="help" id="chapter-permission">{format(t.grantChapterAt, { origin: chapterOrigin })}</p>
              <button class="button" aria-disabled={requestingPermission} onclick={() => permitImage(chapterOrigin!, true)}>{t.allowImage}</button>
              {#if permissionError}<p class="help permission-error" role="alert">{permissionError}</p>{/if}
            {:else}
              <p class="help" role="status">{t.permissionContinue}</p>
            {/if}
          {:else if tab.chapter.message}<p class="help">{localizedError(locale, tab.chapter.message)}</p>{/if}
        {:else}
          <p class="help">{tab.chapterScope === "mounted" ? t.loadedScope : t.processChapter}</p>
        {/if}
        {#if inProgress}
          <div class="chapter-actions">
            {#if !chapterOrigin}
              <button class="button" class:primary={tab.chapter?.phase === 'paused'}
                aria-disabled={busy || (tab.chapter?.phase !== 'paused' && !!tab.chapter?.message)}
                onclick={() => {
                  if (tab.chapter?.phase === 'paused') void chapterCommand('resume');
                  else if (!tab.chapter?.message) void chapterCommand('pause');
                }}>{tab.chapter?.phase === 'paused' ? t.continue : t.pause}</button>
            {/if}
            <button class="button" onclick={() => chapterCommand('stop')} disabled={busy}>{t.stopChapter}</button>
          </div>
        {:else if preview}
          <p class="help" bind:this={previewSummary} tabindex="-1">{t.reviewCopy}</p>
          {#if settings.provider !== 'chrome'}<p class="help">{t.cloudQuota}</p>{/if}
          <div class="chapter-actions">
            <button class="button primary" onclick={() => chapterCommand('start')} disabled={!settings.enabled || busy}>{t.startTranslation}</button>
            <button class="button" onclick={() => reviewChapter(false)} disabled={busy}>{t.back}</button>
          </div>
        {:else}
          <div class="chapter-actions">
            {#if tab.chapter && canRetryChapter(tab.chapter)}
              <button class="button primary" aria-disabled={!settings.enabled || busy} onclick={() => chapterCommand('retry')}>{t.retryPages}</button>
            {/if}
            <button class="button" bind:this={reviewButton} onclick={() => reviewChapter(true)}
              aria-disabled={!settings.enabled || busy} aria-describedby={!settings.enabled ? 'chapter-disabled' : undefined}>
              {tab.chapter ? t.translateAgain : t.reviewChapter}
            </button>
          </div>
          {#if !settings.enabled}<p class="help" id="chapter-disabled">{t.enableChapter}</p>{/if}
        {/if}
      </section>
    {:else if tabLoaded}
      <p class="help">{t.openChapter}</p>
    {/if}
    <div class="reader-actions">
      <button class="button" aria-disabled={!tab.readerReady || busy} onclick={clearTranslations}>{t.clearTranslations}</button>
      {#if cleared}<p class="help" role="status">{t.clearDone}</p>{/if}
    </div>
    <div class="fields settings-fields">
      <ProviderSelect bind:value={settings.provider} {chromeAvailable} {locale}
        onchange={() => { if (settings) void save({ provider: settings.provider }); }} />
      <LanguageFields bind:source={settings.source} bind:target={settings.target} {locale} onchange={saveLanguages} />
      <InpaintingSelect bind:value={settings.inpaintingMode} {locale}
        onchange={inpaintingMode => void save({ inpaintingMode })} />
    </div>
    {#if !chapterOrigin && tab.pendingOrigin}
      <div class="permit">
        <p class="help">{format(t.grantPanelAt, { origin: tab.pendingOrigin })}</p>
        <button class="button" aria-disabled={requestingPermission} onclick={() => permitImage(tab.pendingOrigin!, false)}>{t.allowImage}</button>
        {#if permissionError}<p class="help permission-error" role="alert">{permissionError}</p>{/if}
      </div>
    {:else if panelPermissionGranted && !chapterOrigin}
      <p class="help" role="status">{t.permissionRetryPanel}</p>
    {/if}
  {:else if !error}
    <p class="status" role="status">{t.loadingSettings}</p>
  {/if}
  {#if error}<p class="status error" role="alert">{error}</p>{/if}
</main>

<style>
  :global(html[data-popup-mode="toolbar"]) { width: 392px; }
  .popup { width: min(392px, 100%); padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  header .brand { min-width: 0; }
  header h1 { font-size: 21px; }
  header .button { padding-inline: 7px; font-size: 14px; }
  .mode { display: grid; gap: 8px; }
  .mode-body { padding: 12px 14px; background: var(--surface); border-radius: 12px; display: grid;
    grid-template-columns: 1fr auto; align-items: center; gap: 3px 9px; }
  .mode-label { font-weight: 620; }
  .mode-body p { color: var(--muted); font-size: 14px; }
  .mode-body .ready { color: var(--accent); }
  .mode-body button { grid-column: 2; grid-row: 1 / span 2; font-size: 14px; }
  .fields, .permit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .reader-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .reader-actions .button { font-size: 14px; }
  .settings-fields { padding-top: 12px; border-top: 1px solid var(--rule); }
  .permit button { justify-self: start; }
  .chapter { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; padding: 12px 14px; background: var(--surface); border-radius: 12px; }
  .chapter h2 { font-size: 17px; }
  .chapter-status { font-size: 14px; font-weight: 620; }
  .chapter-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .popup .button[aria-disabled="true"] { opacity: .53; cursor: not-allowed; }
  .chapter .button { justify-self: start; font-size: 14px; }
  progress { width: 100%; height: 7px; accent-color: var(--accent); }
  .chapter p, .permit p { overflow-wrap: anywhere; }
  .chapter .help.permission-error, .permit .help.permission-error { color: var(--error); }
  @media (max-width: 300px) {
    .mode-body { grid-template-columns: 1fr; }
    .mode-body button { grid-column: 1; grid-row: auto; justify-self: start; }
  }
  @media (max-width: 235px) {
    .popup { padding-inline: 10px; }
    header { flex-wrap: wrap; }
    header h1 { font-size: 19px; }
    .fields :global(.languages) { grid-template-columns: minmax(0, 1fr); }
    .popup .button { max-width: 100%; white-space: normal; }
  }
</style>
