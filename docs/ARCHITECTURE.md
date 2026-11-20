# Arsitektur Manga Translator

Dokumen ini menetapkan kontrak implementasi dan urutan verifikasi. Extension Chromium MV3 mengubah panel yang diklik menjadi patch gambar lokal. Provider cloud menerima teks hasil OCR dan konteks teks yang diaktifkan pengguna.

## Batas modul

| Context | Tanggung jawab |
| --- | --- |
| Content script | Registry sumber halaman `<img>`, `<picture>`, dan canvas yang dikenali. Mengelola pemetaan koordinat, pemilihan manual, kontrol, dan canvas patch. |
| Service worker | Validasi sender dan pesan, izin per origin, pengambilan gambar, antrean per browser, pengaturan, kredensial, provider dan status job. |
| Offscreen document | Menjaga dedicated worker tetap tersedia, menjembatani RPC dan menjalankan Chrome Translator saat API tersedia di document. |
| Inference worker | Decode dan crop, deteksi panel, OCR, reading order, mask, inpainting, typesetting dan encoding patch. |
| Popup dan Options | Aktivasi tab, pemilihan bahasa, pengaturan, pemberian izin dan tes koneksi. |

`src/types` memuat kontrak data yang dapat diserialisasi. `src/messaging` memuat pesan dan validasi input runtime. `src/core` memiliki modul independen untuk geometri, transport gambar, model, cache, pipeline dan provider. `src/entrypoints` merangkai runtime. `src/storage` memisahkan settings publik dan kredensial.

## Kontrak antarkomponen

- `ImageDescriptor` membawa ID lokal, jenis sumber, alamat sumber dan dimensi intrinsik. Untuk canvas dan pilihan viewport, alamat menandai dokumen reader. Panel, pemilihan manual, dan posisi patch memakai geometri ternormalisasi terhadap sumber. Region OCR dan bubble memakai koordinat piksel crop untuk mask dan layout.
- Content mengirim `PREFETCH`, `PROCESS_PANEL`, dan `CANCEL` dengan ID. Service worker mengirim panel map, tahap job, patch atau error. Port top-frame mengikat status dan hasil kepada dokumen pengirim. Pengaturan dan operasi kredensial memakai protokol terpisah dari port reader.
- Dokumen offscreen menerima operasi bertipe deteksi, baca dan render. Blob masukan berpindah melalui IndexedDB sementara dan `postMessage` worker. Patch PNG dikirim melalui pesan ekstensi sebagai string data. Crop sementara dilepas saat sukses, gagal, maupun batal.
- `TranslationRequest.segments` disusun menurut reading order. `TranslationResult` divalidasi terhadap himpunan ID sumber dan dikembalikan menurut urutan input. LLM menerima satu request terstruktur per panel. Provider lainnya dapat mengirim batch sesuai API.
- Tindakan pengguna yang memerlukan tangkapan memakai `activeTab`. Service worker meminta snapshot geometri dari dokumen pengirim, memvalidasi tab dan geometri sebelum dan sesudah capture, lalu mengirim tangkapan ke inference worker untuk langsung dipotong. Hanya crop yang dipakai oleh cache dan pipeline. Panel hasil dipetakan kembali ke koordinat halaman atau area pilihan.
- Inference worker memvalidasi mask per kelompok teks sebelum terjemahan. Satu kelompok yang gagal tetap asli, dan kelompok yang lolos dapat diproses. Jika semua kelompok gagal, job berhenti sebelum memanggil provider.
- `JobQueue` menjalankan satu job aktif. Pembatalan adalah kooperatif untuk inference yang sedang berjalan. Cancel saat HTTP aktif menghentikan request. Hasil dari dokumen atau image source lama diabaikan.
- Cache persisten memakai hash SHA-256 dari byte gambar dan identitas operasi. Versi model, geometri, bahasa, konfigurasi provider dan konteks menjadi bagian key yang relevan. Session model diinisialisasi sesuai penggunaan. Kredensial hanya melalui background dan trusted storage.

## Pemilihan sumber halaman

`src/core/surface` mendefinisikan adapter, fakta elemen, dan keputusan apakah suatu sumber layak diproses. Adapter Comic Action mengenali slot canvas reader. Pada situs generik, pemrosesan otomatis membutuhkan gambar yang membentuk kelompok halaman berulang di dalam reader. Klik pengguna pada gambar tunggal tetap tersedia jika elemen tersebut memenuhi syarat dan tidak ditandai sebagai iklan, sampul, atau navigasi. Registry memakai aturan sumber yang sama untuk pemilihan, pre-detection, dan batch gambar generik.

Canvas yang dapat dibaca disalin dari piksel yang sudah dirender. Canvas yang tidak dapat dibaca memakai tangkapan tab aktif setelah tindakan pengguna. Select area dapat dimulai tanpa elemen yang dikenali. Patch yang terikat ke halaman mengikuti geometri elemen. Patch yang terikat ke viewport kedaluwarsa saat tampilan atau dokumen berubah.

## Mode bab

`src/core/chapter` menangani sumber halaman, state job, dan pemulihan patch saat reader mengganti elemen gambar.

- Silent Witch membaca daftar halaman yang ditulis sebagai metadata inline milik reader. Daftar harus berurutan dan seluruh URL harus menunjuk ke path CDN bab aktif. Metadata dibaca sebagai teks.
- MangaDex memakai endpoint At Home untuk manifest halaman dan memilih daftar data-saver sesuai gambar reader. Loader memvalidasi URL dasar, hash dan nama file. Akses API dan host CDN memakai izin origin yang sama dengan akuisisi gambar biasa.
- Comic Action dan reader canvas dengan struktur yang sama menyediakan **Translate visible pages**. Mode ini membatasi antrean pada snapshot halaman yang terlihat. Sumber, identitas halaman, dan posisinya diperiksa kembali sebelum halaman dalam antrean dikerjakan.
- Service worker mengikat sesi ke ID dokumen dan bab, mengambil snapshot pengaturan ketika pengguna memulai, lalu menjalankan halaman melalui JobQueue dan pipeline lokal yang sama. Hasil halaman disimpan di IndexedDB dan hanya referensi kecil yang disiarkan. Content script mengambil patch saat gambar cocok dan mendekati viewport. Patch terikat pada sumber dan identitas dokumen.
- Navigasi ke bab lain membatalkan sesi. Pergantian halaman dalam bab yang sama mempertahankan sesi ketika dokumen yang sama masih dipakai. Jeda menyelesaikan halaman aktif. Penghentian membatalkan halaman aktif dan antrean.
- Pada Silent Witch dan MangaDex, klik tanpa panel yang ditemukan dapat memilih dialog yang memuat titik klik. Seluruh proses deteksi dan verifikasi mask tetap berlangsung di worker. Pemilihan area tetap tersedia bila dialog tidak ditemukan atau mask gagal.

[Rencana UX](CHAPTER-UX-PLAN.md) · [Panduan pengujian](../tests/QA-PLAN.md)

## Milestone

1. Build MV3 dan aktivasi satu tab. Verifikasi registry, pemetaan klik natural, dan overlay responsif.
2. Deteksi gutter pada fixture dan cache panel map. Verifikasi pemilihan titik, hover, dan fallback seleksi area.
3. Jalankan OCR ONNX lokal. Verifikasi ordered segments, WASM, dan resolusi capability WebGPU.
4. Sambungkan enam provider lewat manager. Verifikasi payload teks, kontrak ID, pemetaan error, izin, penyimpanan dan tes koneksi.
5. Bersihkan glyph pada bubble, typeset, dan tampilkan patch. Verifikasi beberapa panel, original toggle, dan kegagalan yang menjaga gambar asli.
6. Jalankan inpainting sesuai kompleksitas. Verifikasi fallback untuk model tambahan yang tidak terpasang.
7. Uji retry, cancel, context, cache, privacy, dan kemas build unpacked. Dokumentasikan cakupan fixture, batas model dan pengujian layanan langsung.
