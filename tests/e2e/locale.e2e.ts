import type { Settings } from '../../src/types/contracts';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, openExtensionPage } from './support/extension';
import { extensionDir, hasBuiltExtension } from './support/paths';
import { expect, test } from './support/test';

const readerUrl = 'https://reader.example/panel';

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');

test('English is the default and Indonesia updates Settings, the popup, and the reader', async () => {
  const extension = await launchExtension(extensionDir(), { grantHosts: ['https://reader.example/*'] });
  try {
    await extension.context.route(readerUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Reader</h1>' }));
    const options = await OptionsClient.open(extension);
    const read = () => options.request<Settings>({ type: 'GET_SETTINGS' });
    const original = await read();
    expect(original.uiLanguage).toBe('en');
    await expect(options.page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(options.page.locator('html')).toHaveAttribute('lang', 'en');
    const selector = options.page.getByRole('combobox', { name: 'Interface language' });
    await expect(selector).toHaveValue('en');
    expect(await selector.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const reader = await extension.context.newPage();
    await reader.goto(readerUrl);
    expect((await options.activate(reader)).ok).toBe(true);
    const overlay = new Overlay(reader);
    await expect(overlay.status).toHaveText('Click the panel you want to translate.');

    await selector.selectOption('id');
    await expect(options.page.getByRole('heading', { name: 'Pengaturan', exact: true })).toBeVisible();
    await expect(options.page.locator('html')).toHaveAttribute('lang', 'id');
    await expect(overlay.status).toHaveText('Klik panel yang ingin diterjemahkan.');
    await expect(overlay.host).toHaveAttribute('lang', 'id');
    const popup = await openExtensionPage(extension, 'popup.html');
    await expect(popup.getByRole('button', { name: 'Pengaturan' })).toBeVisible();
    await expect(popup.locator('html')).toHaveAttribute('lang', 'id');
    const inpainting = popup.getByRole('combobox', { name: 'Mode inpainting' });
    await expect(inpainting).toHaveValue('normal');
    await inpainting.selectOption('conservative');
    await expect(inpainting).toHaveAccessibleDescription(/Risiko perubahan gambar lebih tinggi/);
    await expect.poll(read).toMatchObject({ inpaintingMode: 'conservative' });

    await options.page.reload();
    const indonesia = options.page.getByRole('combobox', { name: 'Bahasa antarmuka' });
    await expect(indonesia).toHaveValue('id');
    await indonesia.selectOption('en');
    await expect.poll(read).toMatchObject({ source: original.source, target: original.target,
      ocrLanguage: original.ocrLanguage, uiLanguage: 'en' });
    await expect(overlay.status).toHaveText('Click the panel you want to translate.');
    await popup.reload();
    await expect(popup.getByRole('button', { name: 'Settings' })).toBeVisible();
    const englishInpainting = popup.getByRole('combobox', { name: 'Inpainting mode' });
    await expect(englishInpainting).toHaveValue('conservative');
    await englishInpainting.selectOption('constrained');
    await expect.poll(read).toMatchObject({ inpaintingMode: 'constrained' });
  } finally {
    await extension.dispose();
  }
});
