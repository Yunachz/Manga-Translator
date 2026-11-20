# Model assets

Run from the repository root with Node.js 20 or later before building the extension.

```sh
node scripts/setup-models.mjs
```

The script installs the four PP-OCRv5 models and three dictionaries in `public/models/`. It downloads missing or invalid ONNX files from pinned Hugging Face revisions, checks the exact size and SHA-256, then renames the temporary file into place. Existing valid files pass verification offline. If a download fails, rerun the command when the source is reachable. The extension build packages the resulting assets for offline inference.

| File under `public/models/` | Role | Model source |
| --- | --- | --- |
| `det.onnx` | Shared PP-OCRv5 mobile text detection | [PaddlePaddle detector](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) |
| `rec-cjk.onnx`, `rec-cjk.json` | Japanese, simplified and traditional Chinese, and mixed Latin recognition | [PaddlePaddle multilingual recognizer](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx) |
| `rec-ko.onnx`, `rec-ko.json` | Korean recognition | [PaddlePaddle Korean recognizer](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx) |
| `rec-en.onnx`, `rec-en.json` | English recognition | [PaddlePaddle English recognizer](https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx) |

[`scripts/model-sources.json`](../scripts/model-sources.json) pins byte counts, SHA-256 values, ONNX links and the corresponding YAML links and hashes. Its ordered JSON dictionaries were extracted from the verified `PostProcess.character_dict` values via PyYAML and checked against the exported ONNX class counts. The Node installer writes the locked arrays directly, so builds require no YAML parser. The raw dictionaries contain 18,383 CJK, 11,945 Korean and 436 English entries. The recognizer adds a CTC blank at index 0 and a single ASCII space at the end. See [the OCR plan](PLANNER.md#pp-ocrv5-assets) for preprocessing and graph contracts.

## Optional models

```sh
node scripts/setup-models.mjs --panel
node scripts/setup-models.mjs --lama
```

Both flags are optional and may be combined. The default setup installs only PP-OCRv5. The flags stage additional assets for a build. Runtime selection stays with the extension's capability and fallback logic.

- `--panel` installs `panel.onnx`, the 10.1 MB YOLO26-nano panel detector ONNX export. The exporter lists Apache-2.0 and requests attribution to the original model and Manga109-s training dataset. Preserve the license, conversion notice and dataset credit in a redistributable package. [ONNX export and required credits](https://huggingface.co/mednasserallah/manga-panel-detector-yolo26n-onnx/blob/f6b7f3cb2bada1ec7d8b16501f9c984890811445/README.md)
- `--lama` installs `lama.onnx`, the 208 MB LaMa FP32 ONNX export. The model card lists Apache-2.0 and credits the original LaMa work, the ONNX conversion and the Places2 dataset. Keep these credits and run Chromium operator, memory and quality gates before packaging it for readers. [LaMa export and credits](https://huggingface.co/sapienkit/LaMa-ONNX/blob/0153b00d76c01058d825296ee162b46ff75ce05d/README.md)

PaddlePaddle lists the PP-OCRv5 models under Apache-2.0. Preserve PaddlePaddle attribution, the Apache-2.0 license, and any upstream notices when redistributing these weights and dictionaries. [PaddleOCR license](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)
