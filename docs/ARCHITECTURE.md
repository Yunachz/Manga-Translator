# Manga Translator architecture

The Chromium MV3 extension turns a selected panel into a locally rendered image patch. Cloud providers receive the recognized text and any optional text context the user enables.

[![Architecture diagram showing the reader, service worker, local inference, and optional cloud translation](architecture.svg)](architecture.svg)

## Module boundaries

| Context | Responsibilities |
| --- | --- |
| Content script | Tracks eligible `<img>`, `<picture>`, and canvas reader pages. Handles coordinate mapping, manual selection, reader controls, and the canvas overlay. |
| Service worker | Validates messages and senders. Manages per-origin permissions, image retrieval, the browser-wide job queue, settings, credentials, providers, and job status. |
| Offscreen document | Hosts the dedicated worker, bridges RPC, and runs Chrome Translator when its API is available in the document. |
| Inference worker | Decodes and crops images, detects panels, runs OCR, orders dialogue, prepares masks, cleans and replaces text, and encodes patches. |
| Popup and Settings | Activate the reader in the current tab, select languages and providers, grant permissions, and test connections. |

`src/types` defines serializable contracts. `src/messaging` defines messages and validates runtime inputs. `src/core` contains independent modules for geometry, image transport, models, caching, the pipeline, and providers. `src/entrypoints` wires the runtime together. `src/storage` separates public settings from credentials.

## Runtime contracts

- `ImageDescriptor` carries a local ID, source type, URL, and intrinsic dimensions. For canvas sources and viewport selections, the URL identifies the reader document. Panel, selection, and patch geometry is normalized to the source. OCR and bubble regions use crop pixel coordinates for masking and layout.
- The content script sends `PREFETCH`, `PROCESS_PANEL`, and `CANCEL` with IDs. The service worker returns panel maps, job stages, patches, or errors. The top-frame port ties updates to the originating document. Settings and credentials use a separate protocol.
- The offscreen document exposes typed detect, read, and render operations. Input blobs pass through temporary IndexedDB storage and worker `postMessage`. PNG patches travel across extension messages as data strings. Temporary crops are released after success, failure, or cancellation.
- `TranslationRequest.segments` follows reading order. The pipeline validates `TranslationResult` against the original IDs and restores the input order. LLM providers receive one structured request per panel. Other providers can batch segments according to their API.
- A user-initiated capture uses `activeTab`. The service worker requests a geometry snapshot, validates the tab and geometry before and after capture, and sends the pixels to the inference worker for immediate cropping. The pipeline and cache use the crop. Patch coordinates map back to the page or selection.
- The inference worker validates masks per text group before translation. Groups with unsafe masks retain the original lettering. When every group fails, the job ends before calling the provider.
- `JobQueue` runs one active job. Inference cooperates with cancellation. Cancelling an active HTTP step aborts the request. The reader ignores results from stale documents or image sources.
- The persistent cache uses SHA-256 of image bytes and operation-specific inputs, such as model version, geometry, language, provider configuration, and context. Model sessions load on demand. Credentials stay in the background service worker and trusted storage.

## Page source selection

`src/core/surface` defines reader adapters, element properties, and source eligibility. Canvas adapters recognize reader page slots. Generic batch mode looks for groups of repeated page images inside the reader. A single eligible image can still be selected by clicking it. Ads, covers, and navigation are filtered from eligible sources. The registry uses the same rules for selection, pre-detection, and generic image batches.

The extension copies rendered pixels from readable canvases. If direct pixel reads fail, it can capture the active tab after a user action. **Select area** can start even when the extension has no recognized page element. Page-bound patches follow element geometry. Viewport-bound patches expire when the view or document changes.

## Chapter mode

`src/core/chapter` handles page sources, job state, and patch restoration when the reader replaces image elements.

- An inline-metadata adapter reads an ordered page list as text and validates that every URL points to the current chapter’s CDN path. An API adapter validates the base URL, hash, and filenames in a page manifest. It selects a reduced-size image list when the reader uses one and requests access to the API or image origin as needed.
- Supported canvas readers offer **Translate visible pages**. The queue starts from a snapshot of visible pages and revalidates the source, page identity, and position before processing each page.
- The service worker binds the session to a document and chapter ID, snapshots settings at start, and runs pages through the same local pipeline and `JobQueue`. IndexedDB stores patches, while messages carry small references. The content script retrieves each patch when a matching image nears the viewport.
- Navigating to another chapter cancels the session. Switching pages within the same chapter can retain an active session when the reader keeps the same document. Pausing lets the active page finish. Stopping cancels the active page and the remaining queue.
- On readers with dialog-level fallback, a click can select the text region under the pointer when the panel is unclear. Detection and mask validation still run in the worker. **Select area** remains available when the automatic selection or mask fails.

[Chapter UX plan](CHAPTER-UX-PLAN.md) · [QA guide](../tests/QA-PLAN.md)

## Verification milestones

1. Build Manifest V3 and activate one tab. Verify the page registry, natural-image coordinate mapping, and responsive overlays.
2. Verify gutter detection, panel caching, click selection, hover outlines, and manual selection fallback on fixtures.
3. Verify local ONNX OCR, ordered segments, WASM inference, and WebGPU capability detection.
4. Connect all six providers through the manager. Verify text payloads, segment IDs, error mapping, permissions, credential storage, and connection tests.
5. Verify text removal, typesetting, and patch rendering across multiple panels. Test the original toggle and failures that preserve the original image.
6. Verify adaptive inpainting and fallback when optional models are absent.
7. Test retries, cancellation, context, cache, and privacy controls. Verify the unpacked build and document fixture coverage, model limitations, and live provider tests.
