const { GoogleGenerativeAI } = require("@google/generative-ai");

async function parseReceipt(base64Image, mimeType) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY tidak tersedia.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

module.exports = { parseReceipt };
