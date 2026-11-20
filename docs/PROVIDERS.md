# Konfigurasi translator

Buka **Pengaturan** dari popup. Pilih provider dan pasangan bahasa. Untuk layanan cloud, masukkan key, berikan izin host, simpan, lalu klik **Tes koneksi**. Tes memakai satu contoh pendek dan dapat memakai kuota penyedia.

| Provider | Key dan pengaturan | Endpoint |
| --- | --- | --- |
| Gemini API | API key Google AI Studio. Model awal `gemini-2.5-flash`. Ganti dengan model yang mendukung structured JSON bila perlu. | `generativelanguage.googleapis.com` |
| OpenAI API | API key proyek OpenAI. Model awal `gpt-4.1-mini`. Model perlu mendukung Structured Outputs melalui Responses API. | `api.openai.com` |
| Chrome Translator | Key tidak diperlukan. Provider muncul saat browser menyediakan API. Gunakan **Tes koneksi** untuk menyiapkan pasangan bahasa. | API browser |
| Google Cloud Translation | Aktifkan Cloud Translation API dan billing pada proyek Cloud. Buat API key yang dapat memakai Cloud Translation Basic v2. | `translation.googleapis.com` |
| DeepL API | API key paket DeepL API Free atau Pro. Pilih paket yang cocok di Options. | `api-free.deepl.com` atau `api.deepl.com` |
| Azure Translator | Key resource Translator. Isi region untuk resource regional atau multi-service. | `api.cognitive.microsofttranslator.com` |

Gemini dan OpenAI menerima satu request untuk semua dialog pada panel. ID setiap bubble diperiksa dan hasil dipetakan kembali ke urutan OCR. Opsi konteks dapat menambahkan judul seri, glosarium dalam format `istilah = terjemahan`, dan panel sebelumnya. Provider lainnya memakai batch standar atau penerjemah lokal. Bahasa yang tersedia bergantung pada penyedia.

Chrome Translator dapat mengunduh paket bahasa melalui browser. Pilih bahasa asal eksplisit dan uji pasangan tersebut di Pengaturan jika pasangan belum siap. Browser Chromium lain dapat menyembunyikan provider ini. Pilih salah satu provider cloud jika API lokal tidak tersedia.

Respons 401/403 atau error key yang dinyatakan provider ditampilkan sebagai masalah otorisasi. Error kuota dan rate limit dipisahkan ketika provider menyediakan kode yang membedakannya. Kegagalan tidak memproduksi patch. Perbaiki konfigurasi lalu klik **Coba lagi** di reader.
