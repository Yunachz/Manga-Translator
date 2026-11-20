# Chromium MV3 reader QA

## Fixture setup

Run from the repository root. The server binds to loopback and serves only the fixture directory.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory tests/fixtures
```

Open `http://127.0.0.1:8765/reader.html` in Chromium. [reader.html](fixtures/reader.html) contains a plain `<img>` and a below-the-fold `<picture>` with a lazy-loaded `<img>`. Both start on Page A. **Queue Page B** changes the picture's selected source when the image enters the viewport. The picture `<img>` element and its fallback `src` stay in place. Reload the page to reset the fixture.

Use the checked-in grayscale PNGs for runtime tests. They contain original artwork and baked-in Japanese and English text. Both images are 1000 × 1200 pixels. The text in the reader DOM is limited to fixture controls and descriptions.

## Geometry and click oracle

[expected-panels.json](fixtures/expected-panels.json) gives ground truth for the outer ink borders, bubble clicks, source text and gutter misses. Bounds use `[left, top, width, height]` and click points use `[x, y]`, normalized to image content. Coordinates start at the top left. A and B follow right-to-left panel order within each row.

| Page | Panel order | Positive clicks in natural image pixels |
| --- | --- | --- |
| A | A1 top right, A2 top left, A3 bottom right, A4 bottom left | A1 `(730, 200)`, A2 `(270, 200)`, A3 `(730, 760)`, A4 `(270, 760)` |
| B | B1 full-width top, B2 bottom right, B3 bottom left | B1 `(660, 200)`, B2 `(780, 760)`, B3 `(325, 760)` |

Use the current `getBoundingClientRect()` for `#plain-page` or `#picture-page` after scrolling. For normalized `[x, y]`, compute `clientX = rect.left + x * rect.width` and `clientY = rect.top + y * rect.height`. Scroll the intended point into view before computing its viewport coordinates. Use real browser pointer input for extension click tests.

The cross-source probes `[0.50, 0.25]` and `[0.59, 0.633333]` reveal stale panel geometry. The first changes from a gutter on A to B1. The second changes from A3 to a gutter on B. If the implementation exposes panel boxes, record each normalized edge delta and compare it with the ground truth. For a geometry sanity check, use ±0.02 per edge and investigate any missed or merged panel regardless of the edge deltas.

## Verify the fixture alone

1. At the top of a fresh reader tab, confirm that the plain image displays the four-panel Page A. The picture element sits below the viewport.
2. With DevTools Network open, click **Queue Page B**. Confirm that the control reads `Page B queued` and the network log has no request for `page-b.png` while the picture stays out of view.
3. Follow **Go to picture reader**. Confirm that the status reads `Page B loaded`, the picture displays three panels and `document.querySelector('#picture-page').currentSrc` ends with `/page-b.png`. Its `src` attribute still reads `./page-a.png?fallback`. Scroll back to the plain image and confirm that it still shows A.
4. Reload the fixture and go to the picture without queuing B. Confirm that its `currentSrc` ends with `/page-a.png` and that its four panels match the plain image.

## Run the integrated extension

Use a clean Chromium profile. Enable developer mode at `chrome://extensions`, load the project's unpacked MV3 build and record the browser version, extension version and tested commit. Use the activation and translation controls documented by the implementation. Reload the fixture tab after extension reloads. Grant local-origin access through Chromium if the extension requests it.

| Case | Exercise in Chromium | Pass evidence |
| --- | --- | --- |
| MV3 load and activation | Open the local reader and activate the extension through its intended entry point. Test the initial inactive state if exposed. | No extension load or service worker registration errors. The control state matches the documented activation flow. Reader controls still work. |
| Plain image selection | Click A1–A4 on `#plain-page`. Also click the three outside-panel points in the oracle. | Each positive point selects its own panel and crop. Gutters and margins have no panel hit. Record the visible behavior on a miss. |
| Picture source resolution | Load `#picture-page` as A and select A3. Compare the selected image URL or pixels with the actual `currentSrc` and repeat after swapping. | Picture selection works. After the swap, B supplies the image and the selected crop even though the fallback `src` still references A. |
| Deferred swap | Queue B from the top and enter the picture. Check all B panel points, both cross-source probes and the plain image after the swap. | A remains selected until the intersection. B exposes three panels and the probes flip as expected. The plain image still hits A panels. |
| Same-element refresh | Visit the picture as A, select a panel, scroll back to the top and queue B. Return and immediately select B1. For a delayed translation path, complete an older A request after B becomes current. | New clicks use B as soon as it loads. Any old overlay or delayed result stays scoped to A and never renders on B. |
| Coordinate alignment | Repeat one positive and one gutter click after scrolling and at a narrower viewport or 125% browser zoom. Reposition or dismiss and reopen an overlay if the UI supports it. | Panel targeting and visible output stay aligned to the displayed image. Image clicks and reader scrolling still work after dismissal. |
| OCR and translation | If the build supports local OCR or an authorized mock, run one `ja` and one `en` bubble from the oracle. Use the returned fixture text or an agreed canned translation to exercise the UI. | The crop contains the expected single bubble. Compare OCR with the oracle, allowing line-wrap and punctuation differences while recording transcription errors. The output appears on the selected panel only. |
| Missing configuration and failure | With empty settings, activate the documented translation action. If a mock is available, exercise a deterministic success, a rejected response and a delayed response followed by retry. | The UI reports its actual configuration or request status, recovers after failure and leaves the reader usable. Requests and errors stay scoped to the selected panel. |

Use empty credentials for fixture, detection and interaction checks. Run local OCR or a translation mock only if the integrated build supports it. Canned responses can exercise rendering but provide no evidence about live provider accuracy. Mark provider-dependent cases blocked if the build lacks a usable local path. Keep real API keys and provider headers out of fixture source, screenshots, logs and QA reports.

Record pass, fail or blocked per case with the image source, panel ID or click point, observed behavior and any sanitized console error. Record whether OCR and translation ran locally, used a mock or were blocked. Capture screenshots for clear visual regressions.

## Regenerate raster assets

The editable artwork is in [page-a.svg](fixtures/page-a.svg) and [page-b.svg](fixtures/page-b.svg). With Noto Sans CJK JP and DejaVu Sans installed, run this from the repository root. Match the Chromium and font versions if byte-for-byte comparison matters.

```sh
for page in a b; do
  chromium --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1000,1200 --screenshot="$(pwd)/tests/fixtures/page-$page.png" \
    "file://$(pwd)/tests/fixtures/page-$page.svg"
done
```

## Automated suites

Run from the repository root.

```sh
npx vitest run                                              # unit, contract and packaged-asset checks
npm run build && npx playwright test -c tests/e2e/playwright.config.ts   # fixture + integrated extension smoke
```

Playwright needs its Chromium (`npx playwright install chromium`); the headless shell cannot load extensions. The suite starts a loopback fixture server and an HTTPS provider mock. Provider hostnames resolve to the mock, every other external host fails to resolve, and the only secret is the sentinel `mock-key-not-a-credential`. No real key, network call or publication is involved.

| Area | Files |
| --- | --- |
| Geometry, coordinate mapping, gutter detection (synthetic pixels and the PNG fixtures against `expected-panels.json`) | `tests/core/image`, `tests/core/panel` |
| Stable cache keys, job queue and job state transitions | `tests/core/cache`, `tests/core/pipeline` |
| Reading order, line wrapping and font fitting | `tests/core/reading-order`, `tests/core/typesetting` |
| Provider catalog, six adapters, segment validation, HTTP error mapping, manager | `tests/core/translation` |
| CTC decoding and text region extraction | `tests/core/ocr`, `tests/core/detection` |
| Packaged models and build contents (build checks skip when `.output/chrome-mv3` is absent) | `tests/build` |
| Fixture reader alone | `tests/e2e/fixtures.e2e.ts` |
| Built extension in a persistent Chromium profile | `tests/e2e/extension-smoke.e2e.ts` |

Host access: Chromium cannot automate the optional host-permission prompt, and the request hangs in headless mode. The "granted" smoke group therefore runs a temporary copy of the build with `host_permissions` added for the fixture origin and the provider hosts. The "as packaged" group uses the build untouched. Granting an origin through the real prompt stays a manual check from the integrated table above.

Set `MANGA_EXTENSION_DIR` to test a build in another directory. Set `FLOW_TIMEOUT` (milliseconds) to shorten the wait for OCR flows.


## Regresi pengambilan gambar

Jalankan `npm run test:e2e -- --grep 'HTTP 403'` setelah build. Fixture hanya mengizinkan request gambar dari elemen reader dan menolak fetch ulang dengan HTTP 403. Pengujian mengaktifkan **Pilih area terlihat**, menyeret panel Inggris, dan memeriksa OCR lokal, jumlah request, posisi patch, serta toggle gambar asli. Chrome menangkap tab dari profil sementara yang dipakai suite. Paket rilis memakai izin `activeTab` yang sudah digunakan untuk aktivasi.

## Hasil v0.1.1 di reader live

Profil Chromium sementara memuat gambar asli dari reader. PaddleOCR dalam mode WASM mengenali teks Inggris, lalu endpoint tiruan mengembalikan teks Indonesia. Pengujian memeriksa posisi patch dan toggle gambar asli. Profil uji memberikan akses host terlebih dahulu.

| Reader | Hasil |
| --- | --- |
| [MangaFire, chapter 171](https://mangafire.to/title/ro8ro-all-class-awakening-god-slayer/chapter/9569470) | Tautan transparan di atas gambar tertangani dalam mode terjemahan. CDN menolak fetch ulang dengan HTTP 403. **Pilih area terlihat** berhasil pada kotak narasi yang dilaporkan. |
| [Secrets of the Silent Witch, chapter 33](https://w2.secretsofthesilentwitch.online/chapters/33/) | Klik menghasilkan patch dengan tujuh kelompok teks. Tiga kelompok dengan mask yang ditolak tetap asli. Memilih balon yang dilaporkan secara manual juga menghasilkan patch. |
| [MangaKatana, Onepunch-Man chapter 1](https://mangakatana.com/manga/onepunch-man.437/c1) | Klik menghasilkan patch dari teks Inggris pada halaman pengantar. Satu kelompok dengan mask yang ditolak tetap asli. |
| [MangaDex](https://mangadex.org/) | Koneksi lingkungan uji mengalami kegagalan DNS/TLS sebelum reader dapat dibuka. |

Lint, typecheck, 496 pemeriksaan Vitest, 35 skenario Playwright, dan verifikasi isi ZIP lulus. Satu tes Vitest untuk kondisi build belum tersedia dilewati karena build sudah ada.
