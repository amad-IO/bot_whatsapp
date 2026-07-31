const { GoogleGenerativeAI } = require("@google/generative-ai");

async function parseReceipt(base64Image, mimeType) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY tidak tersedia.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

    const prompt = `
Anda adalah sistem pengekstrak struk belanja otomatis.
Tugas Anda adalah membaca gambar struk dan mengekstrak barang-barang beserta harganya.
Format output Anda HARUS berupa JSON murni tanpa markdown, tanpa embel-embel, dengan struktur sebagai berikut:
{
  "is_readable": true|false,
  "items": [
    {
      "qty": number,
      "nama_barang": "string",
      "harga_satuan": number,
      "subtotal": number
    }
  ],
  "total": number
}
Jika struk terlalu buram, potong, atau tidak bisa dibaca, set "is_readable": false dan array kosong.
Pastikan total sesuai dengan jumlah harga di struk. Jika qty tidak ada, asumsikan 1.
HANYA KELUARKAN JSON VALID.
`;

    const image = {
        inlineData: {
            data: base64Image,
            mimeType: mimeType
        }
    };

    const result = await model.generateContent([prompt, image]);
    const response = await result.response;
    let text = response.text();
    text = text.replace(/```json/gi, "").replace(/```/gi, "").trim();
    
    return JSON.parse(text);
}

async function chatWithContext(userText, kontaks, qris) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY tidak tersedia.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

    const prompt = `Anda adalah asisten cerdas untuk membantu pengguna mengelola Bot WhatsApp Split Bill.
Anda memiliki akses ke daftar kontak (maks 25 terakhir) dan daftar QRIS pengguna.

Daftar Kontak Pengguna (nomor, nama):
${JSON.stringify(kontaks)}

Daftar QRIS Pengguna (id, nama_rekening):
${JSON.stringify(qris)}

Instruksi:
1. Jika pengguna bertanya tentang kontak, carilah di daftar kontak dan jawablah dengan ramah berdasarkan data di atas. (Jika ditanya nomor si X, cari X dan sebutkan nomornya).
2. Jika pengguna meminta untuk MELIHAT gambar QRIS tertentu, Anda HARUS meminta izin terlebih dahulu ("Apakah Anda ingin saya tampilkan gambar QRIS-nya?").
3. Jika pengguna SUDAH mengiyakan (setuju/memberi izin) untuk menampilkan QRIS, Anda HARUS merespons dengan tag khusus: [TAMPILKAN_QRIS_ID_X] (dimana X adalah angka id QRIS). Anda boleh menambahkan pesan pendamping, contoh: "Baik, ini dia QRIS-nya: [TAMPILKAN_QRIS_ID_1]".

Pesan pengguna: ${userText}
`;
    const result = await model.generateContent(prompt);
    return result.response.text();
}

module.exports = { parseReceipt, chatWithContext };
