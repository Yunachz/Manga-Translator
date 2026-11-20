# Set up a translation provider

Open **Settings** from the popup and choose a provider, source language, and target language. For a cloud provider, enter your own API key, select **Allow provider access**, save, and run **Test connection**. The test sends a short sample and may count toward your provider’s quota.

| Provider | Credentials and settings | Host |
| --- | --- | --- |
| Gemini API | Use an API key from Google AI Studio. The extension defaults to `gemini-2.5-flash`. A custom model must support structured JSON output. | `generativelanguage.googleapis.com` |
| OpenAI API | Use an OpenAI project API key. The extension defaults to `gpt-4.1-mini`. A custom model must support Structured Outputs through the Responses API. | `api.openai.com` |
| Chrome Translator | Uses the browser’s built-in API where available. Run **Test connection** to prepare the selected language pair. | Browser API |
| Google Cloud Translation | Enable Cloud Translation and billing for your Cloud project. Use an API key with access to Cloud Translation Basic v2. | `translation.googleapis.com` |
| DeepL API | Use an API key for DeepL API Free or Pro and select the matching plan in **Settings**. | `api-free.deepl.com` or `api.deepl.com` |
| Azure Translator | Use a Translator resource key. Enter the region for a regional or multi-service resource. | `api.cognitive.microsofttranslator.com` |

## Context and local translation

Gemini and OpenAI receive the dialogue in a panel as one structured request. The extension matches every response segment by bubble ID and restores the OCR order. You can include a series title, previous panel dialogue, or glossary entries in `term = translation` format. Other providers use standard translation batches or the browser’s local translator.

Chrome Translator may download language packs through the browser. If a language pair is unavailable, choose the source language explicitly and test the pair in **Settings**. Choose a cloud provider if your browser lacks the built-in API. Supported language pairs vary by provider.

## Troubleshooting

HTTP 401/403 responses and provider-reported key errors appear as authorization failures. Quota and rate limits are reported separately when the provider distinguishes them. A failed request leaves the original panel visible. Correct the setting and select **Retry** in the reader.

[Privacy and permissions](../README.md#privacy-and-permissions)
