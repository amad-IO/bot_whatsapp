require('dotenv').config();

const WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;
const TOKEN = process.env.GOOGLE_SHEET_TOKEN;

if (!WEBHOOK_URL) {
  console.error('GOOGLE_SHEET_WEBHOOK_URL tidak ada di .env');
  process.exit(1);
}

const data = {
  token: TOKEN,
  waktu_transaksi: '2026-07-20 20:25:00',
  kategori: 'Makan',
  nominal: 25000,
  tipe: 'Keluar',
  rekening: 'BCA',
  keterangan: 'saya beli gacoan 25000 - test dari script'
};

console.log('Mengirim ke Sheets...');

fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
  redirect: 'follow'
}).then(async res => {
  const text = await res.text();
  console.log('HTTP Status:', res.status);
  console.log('Response:', text.substring(0, 300));
  if (res.ok) {
    console.log('\n✅ Berhasil! Cek Google Sheets Anda.');
  } else {
    console.log('\n❌ Gagal. HTTP:', res.status);
  }
}).catch(e => {
  console.error('Error:', e.message);
});
