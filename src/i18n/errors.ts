import type { UiLanguage } from './messages';

// Engine errors cross the worker boundary without a UI locale. Translate them at display time.
const english = new Map<string, string>([
  ['Aktifkan extension terlebih dahulu.', 'Enable the extension first.'],
  ['Area layar hanya dapat dibaca lewat tangkapan tab.', 'This area can be read only from a tab capture.'],
  ['Canvas reader tidak dapat dibaca langsung.', 'This reader canvas cannot be read directly.'],
  ['Antrean penuh. Tunggu proses yang sedang berjalan.', 'The queue is full. Wait for a current job to finish.'],
  ['API key tidak valid atau tidak diizinkan untuk provider ini.', 'The API key is invalid or cannot access this provider.'],
  ['Berkas gambar tidak tersedia. Coba lagi.', 'The image file is unavailable. Try again.'],
  ['Belum ada gambar halaman manga yang termuat di tab ini. Tunggu halaman tampil atau gulir sendiri, lalu coba lagi.', 'No manga page images are loaded in this tab. Wait for the pages to appear or scroll to load them, then try again.'],
  ['Berikan izin akses provider di Pengaturan.', 'Allow access to the provider in Settings.'],
  ['Browser tidak dapat menangkap tab. Buka popup, aktifkan kembali mode, lalu pilih area.', 'The browser could not capture the tab. Re-enable panel mode from the popup and select the area again.'],
  ['Buka halaman HTTP(S) reader aktif terlebih dahulu.', 'Open an HTTP or HTTPS reader in the active tab.'],
  ['Buka kembali tab reader dan pilih area yang terlihat.', 'Return to the reader tab and select an area that is visible.'],
  ['Chrome Translator belum siap untuk pasangan bahasa ini. Coba siapkan di Pengaturan atau pilih provider lain.', 'Chrome Translator is not ready for this language pair. Set it up in Settings or choose another provider.'],
  ['Daftar halaman bab belum ditemukan. Tunggu bab tampil, lalu coba lagi.', 'The chapter page list is unavailable. Wait for the chapter to load, then try again.'],
  ['Daftar halaman MangaDex tidak bisa dihubungi.', 'Could not load the MangaDex page list.'],
  ['Deteksi teks lokal gagal.', 'Local text detection failed.'],
  ['Dialog yang terbaca di area ini sudah diterjemahkan.', 'The dialogue detected in this area is already translated.'],
  ['Dimensi gambar terlalu besar untuk diproses.', 'The image dimensions exceed the processing limit.'],
  ['Extension tidak dapat aktif di tab ini. Buka kembali reader dan coba lagi.', 'The extension could not start in this tab. Reopen the reader and try again.'],
  ['Extension tidak merespons.', 'The extension is not responding.'],
  ['Format daftar halaman MangaDex belum didukung.', 'This MangaDex page list format is unsupported.'],
  ['Format gambar tidak didukung untuk pemrosesan lokal.', 'This image format is unsupported for local processing.'],
  ['Gambar reader tidak dapat dibaca langsung. Gunakan Pilih area pada panel yang tampil.', 'Could not read the image from the reader. Use Select area on the displayed panel.'],
  ['Gambar reader tersedia di tab. Gunakan Pilih area pada panel yang tampil.', 'The image is available in the reader. Use Select area on the displayed panel.'],
  ['Gambar tidak dapat diambil. Situs mungkin membatasi akses gambar.', 'Could not load the image. The site may restrict access.'],
  ['Inference worker tidak dapat dimulai.', 'Could not start the local inference worker.'],
  ['Inference worker tidak dapat dijalankan.', 'The local inference worker is unavailable.'],
  ['Instruksi extension tidak valid.', 'Invalid extension command.'],
  ['Izinkan akses gambar di popup. Terjemahan akan lanjut otomatis.', 'Allow image access in the popup. Translation resumes automatically.'],
  ['Izinkan domain gambar dari popup, lalu pilih Coba lagi.', 'Allow image access from the popup, then select Retry.'],
  ['Izinkan MangaDex untuk membaca daftar halaman chapter.', 'Allow access to the MangaDex chapter page list.'],
  ['Jumlah atau panjang dialog panel melebihi batas.', 'This panel exceeds the dialogue size limit.'],
  ['Kuota terjemahan provider habis.', 'The provider’s translation quota has been reached.'],
  ['Mask teks belum cukup aman. Pilih area di sekitar satu balon dialog.', 'The text could not be removed safely. Select an area around one speech bubble.'],
  ['Mask teks belum cukup aman. Pilih area lebih sempit atau coba panel lain.', 'The text could not be removed safely. Select a smaller area or try another panel.'],
  ['Masukkan API key provider di Pengaturan.', 'Enter the provider API key in Settings.'],
  ['Menjeda setelah langkah ini…', 'Pausing after this step…'],
  ['Mode tab tidak aktif. Aktifkan kembali dari popup.', 'Panel mode is off. Enable it again from the popup.'],
  ['Nama model provider tidak valid.', 'The provider model name is invalid.'],
  ['OCR belum dapat membaca teks panel ini. Periksa bahasa atau pilih area yang lebih sempit.', 'OCR could not read this panel. Check the OCR language or select a smaller area.'],
  ['Tidak ada terjemahan yang bisa dibersihkan di tab aktif.', 'There is no reader translation to clear in the active tab.'],
  ['Panel tidak dapat ditentukan. Gunakan Pilih area.', 'Could not identify the panel. Use Select area.'],
  ['Panel tidak dapat ditentukan. Klik di dalam balon dialog atau gunakan Pilih area.', 'Could not identify the panel. Click inside a speech bubble or use Select area.'],
  ['Pembacaan teks lokal gagal.', 'Local OCR failed.'],
  ['Pembersihan teks lokal gagal.', 'Local text removal failed.'],
  ['Pengambilan gambar terhenti.', 'Image loading was interrupted.'],
  ['Piksel tab tidak dapat dibaca. Pilih ulang area.', 'Could not read the tab image. Select the area again.'],
  ['Proses terhenti. Coba lagi.', 'Processing stopped. Try again.'],
  ['Provider membatasi request. Coba lagi nanti.', 'The provider is rate-limiting requests. Try again later.'],
  ['Provider tidak dapat dihubungi.', 'Could not reach the translation provider.'],
  ['Reader belum terhubung. Coba lagi.', 'The reader is not connected yet. Try again.'],
  ['Respons provider bukan JSON yang valid.', 'The provider returned invalid JSON.'],
  ['Respons terjemahan tidak cocok dengan segmen panel.', 'The translation response does not match the panel text.'],
  ['Runtime lokal tidak merespons. Coba ulangi terjemahan.', 'The local runtime is not responding. Retry the translation.'],
  ['Server gambar menolak request dari extension (HTTP 401/403). Gunakan Pilih area pada panel yang tampil.', 'The image server refused the extension request (HTTP 401/403). Use Select area on a displayed panel.'],
  ['Sumber gambar bukan raster PNG, JPEG, WebP, GIF, AVIF, atau BMP.', 'Use a PNG, JPEG, WebP, GIF, AVIF, or BMP image.'],
  ['Sumber gambar mengirim berkas kosong.', 'The image server sent an empty file.'],
  ['Sumber gambar mengirim respons kosong.', 'The image server returned an empty response.'],
  ['Tab reader berpindah. Pilih ulang area.', 'The reader tab changed. Select the area again.'],
  ['Tampilan reader berubah saat diproses. Pilih ulang area.', 'The reader view changed while processing. Select the area again.'],
  ['Tampilan reader berubah saat menyiapkan tangkapan. Pilih ulang area.', 'The reader view changed while preparing capture. Select the area again.'],
  ['Tampilkan seluruh area yang dipilih di layar, lalu pilih ulang area.', 'Show the entire selection on screen, then select it again.'],
  ['Teks terjemahan bubble tidak tersedia.', 'Translated text is missing for this speech bubble.'],
  ['Terjemahan dibatalkan.', 'Translation canceled.'],
  ['Terjemahan terlalu panjang untuk ditempatkan di bubble.', 'The translation is too long to fit in the speech bubble.'],
  ['Tidak ada teks yang terdeteksi pada panel.', 'No text was detected in this panel.'],
  ['Ukuran gambar melebihi batas 24 MiB.', 'The image exceeds the 24 MiB limit.'],
  ['Waktu tunggu provider habis.', 'The translation provider timed out.'],
]);

const dynamic: [RegExp, string][] = [
  [/^Sumber gambar menolak request \(HTTP (\d+)\)\.$/, 'The image server rejected the request (HTTP $1).'],
  [/^Daftar halaman MangaDex mengembalikan HTTP (\d+)\.$/, 'The MangaDex page list returned HTTP $1.'],
  [/^Provider menolak request \(HTTP (\d+)\)\./, 'The provider rejected the request (HTTP $1). Check the model, language, or plan.'],
  [/^Kamus model lokal "([^"]+)" tidak tersedia\.$/, 'The local model dictionary "$1" is unavailable.'],
  [/^Model lokal "([^"]+)" gagal dimuat\./, 'Could not load the local model "$1". Check the model files and extension build.'],
];

export function localizedError(locale: UiLanguage, message: string): string {
  if (locale === 'id') return message;
  const exact = english.get(message);
  if (exact) return exact;
  for (const [pattern, label] of dynamic) {
    if (pattern.test(message)) {
      const match = message.match(pattern);
      return label.replace('$1', () => match?.[1] ?? '');
    }
  }
  return 'Processing stopped. Try again.';
}
