# TodoList WA, web, dan Nusa

Web produksi: https://20.214.155.243. Login menggunakan kode enam digit Microsoft Authenticator; tidak ada langkah username/password. QR awal hanya melalui tautan pengaturan privat. Sesudah aktivasi, tautan itu tidak dapat digunakan untuk mendaftarkan Authenticator lain.

## Pembaruan server yang sudah dipasang

Jalankan dari `/home/istimata/bot_whatsapp`:

```sh
git pull --ff-only origin main
docker compose -f docker-compose.yml -f docker-compose.secure.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d --no-build --no-deps wagateway
```

Gunakan kedua berkas Compose untuk mempertahankan HTTPS, port loopback, akun database aplikasi, dan mount kode yang sesuai. Image `nusa-todo-release:20261027` sudah dipasang pada server ini dan memuat dependency TodoList. Jika dependency berubah, build image lebih dulu. Image dan konfigurasi privat server tidak disimpan di GitHub.

Jangan memasukkan `.env`, sesi WhatsApp, gambar QRIS, berkas kunci, log percakapan, atau tautan pengaturan privat ke Git. Migrasi mempertahankan ID tugas, mengganti `bot_reminder` menjadi `bot_todolist`, dan tidak menandai selesai hanya karena pengingat terkirim. Kode lama memerlukan pemulihan nama tabel/data sebelum dapat dipakai kembali.

## Konfigurasi privat

Selain konfigurasi WA/database yang sudah ada, runtime memerlukan `PUBLIC_ORIGIN` (HTTPS), `WEB_AUTH_ENCRYPTION_KEY` (64 karakter hex acak), `WEB_SETUP_TOKEN`, dan `NUSA_SYNC_KEY`. Pertahankan nilai pada `.env` produksi agar Authenticator dan penghubung tetap bekerja. Jangan membuat ulang kunci enkripsi pada setiap deployment.

`DESKTOP_API_KEY` membatasi API desktop lama. `SHEETS_SYNC_TOKEN` dan `SHEETS_WEBHOOK_TOKEN` melindungi callback Sheets. Pemanggil eksternal perlu menggunakan alamat HTTPS baru. Kunci mesin tidak memberi akses sesi dashboard.

## Perilaku

- Deadline WIB; percakapan tugas yang belum lengkap disimpan 24 jam.
- Pengingat setiap 12.00 WIB mulai H-2 sampai selesai; tugas lewat deadline tetap aktif.
- Penyelesaian melalui WA/web/Nusa menghentikan pengingat setelah server menerima statusnya.
- Suara memakai Groq; JPG/PNG/WebP/PDF memakai Gemini; maksimal 10 MB.
- Penghubung `nusa-sync` hanya membaca tugas dan mengirim status selesai. Perubahan masuk dari server memuat ulang Nusa. Centang selesai dan pengakuan statusnya tidak merestart Nusa.
- Tugas manual Nusa dipertahankan; pembuatan tugas manual lokal belum diunggah ke server. Ketahanan Pomodoro aktif dan seluruh item Shelf saat restart belum terverifikasi.

## Pemeriksaan

```sh
npm ci
npm run test:todolist
```

Pengujian unit tidak memanggil penyedia AI atau mengirim WA. Integrasi MySQL diaktifkan dengan `RUN_TODO_DB_TESTS=1` dan kredensial database uji yang dapat membuat/menghapus database sementara `nusa_test_*`. Jangan memberikan hak tersebut pada akun runtime aplikasi. Test membuat database terpisah dan tidak menggunakan tabel produksi. `test/todolist-ai-smoke.js` bersifat opsional dan menggunakan API AI yang dikonfigurasi.

Pemulihan Authenticator oleh operator: `npm run admin:setup`, melalui shell privat dengan konfigurasi database yang benar. Reset mencabut sesi/kode pemulihan; tautan pengaturan privat dipakai untuk menghubungkan HP kembali.
