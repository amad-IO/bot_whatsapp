const db = require('./db');

const MAX_RETRIES = 2;

async function panggilGroqJson(systemPrompt, userPrompt, maxTokens) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY belum diset di .env");

  const payload = {
    model: "llama3-70b-8192",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" }
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json" 
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      if (!result.choices || !result.choices[0]) throw new Error("Groq tidak mengembalikan pilihan.");

      const raw = result.choices[0].message.content.trim();
      const jsonStr = extractJson(raw);
      return JSON.parse(jsonStr);
    } catch (err) {
      lastErr = err;
      if (attempt <= MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw new Error(`Groq AI gagal: ${lastErr.message}`);
}

function extractJson(text) {
  let clean = text.replace(/```json|```/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Tidak ditemukan JSON dalam respons AI: "${text}"`);
  return match[0];
}

async function syncToGoogleSheets(data) {
  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) return;
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow'
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[Sheets] Gagal HTTP ${res.status}:`, text.substring(0, 200));
    } else {
      console.log('[Sheets] Sync berhasil:', text.substring(0, 100));
    }
  } catch (e) {
    console.error('[Sheets] Error:', e.message);
  }
}

async function deteksiIntent(text) {
  const now = new Date();
  
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const nowStr = `${yyyy}-${mm}-${dd} ${hh}:${mins}`;

  const systemPrompt =
    "You are an intent classifier for a personal Indonesian WhatsApp bot assistant. " +
    "Understand natural, casual, and slang Indonesian (e.g. 'jajan', 'ngopi', 'nraktir', 'utang', 'pinjem', 'gajian', 'dapet duit', 'keluar duit', 'nombok'). " +
    "For financial transactions: expenses include buying, paying, lending money to others, treating others. " +
    "Income includes receiving salary, getting money, being paid back. " +
    "Output ONLY valid JSON, no markdown, no explanation.";

  const userPrompt =
    `Waktu sekarang: ${nowStr} (WIB, format yyyy-MM-dd HH:mm)\n` +
    `Classify this Indonesian message: "${text}"\n\n` +
    "Possible intents:\n" +
    "- transaksi_keuangan: user mentions any money movement (beli/bayar/jajan/dapat/gajian/pinjem/nombok/nraktir/dll)\n" +
    "- cek_saldo: user asks current balance (saldo, tabungan, punya uang berapa, dll)\n" +
    "- atur_saldo: user wants to SET/RESET a specific account balance to a new value (atur saldo, ubah saldo, set saldo, reset saldo, jadikan saldo, atur ulang saldo, koreksi saldo, dll)\n" +
    "- laporan_keuangan: user asks financial report/summary for any time period\n" +
    "- tambah_reminder: user wants to be reminded of something at a specific time\n" +
    "- list_reminder: user asks to see pending reminders or todo list\n" +
    "- selesai_reminder: user marks a reminder/task as done\n" +
    "- chat_bebas: anything else (general question, casual chat, opinion, explanation)\n\n" +
    "For transaksi_keuangan:\n" +
    "  - cat: category in Bahasa Indonesia (Makanan, Transport, Kesehatan, Hiburan, Pinjaman, Gaji, dll)\n" +
    "  - amt: integer amount (parse '10rb'=10000, '1.5jt'=1500000, '500k'=500000)\n" +
    "  - type: 'Masuk' (receive money) or 'Keluar' (spend/lend money)\n" +
    "  - rek: account name if mentioned (default: 'Cash')\n" +
    "  - waktu_transaksi: if user mentions WHEN the transaction happened, resolve to yyyy-MM-dd HH:mm. If not mentioned, set to null.\n" +
    "For atur_saldo:\n" +
    "  - rek: account name (e.g. 'Cash', 'BCA', 'Dana')\n" +
    "  - amt: the NEW target balance as integer (e.g. 'jadi 97000' → 97000, 'menjadi 30rb' → 30000)\n" +
    "For laporan_keuangan:\n" +
    "  - periode: 'harian' (today) | 'mingguan' (this week) | 'bulanan' (this month, default)\n" +
    "  - rek: specific account name if user asks per-account report, else null\n" +
    "For tambah_reminder:\n" +
    "  - isi: reminder text\n" +
    "  - waktu: resolve relative time to yyyy-MM-dd HH:mm\n" +
    "For selesai_reminder and list_reminder: keyword (text to match, or null for list)\n" +
    "For chat_bebas: pesan (original message)\n\n" +
    "Output format (PURE JSON only, null for unused fields):\n" +
    '{"intent":"string","cat":"string|null","amt":number|null,"type":"string|null","rek":"string|null",' +
    '"isi":"string|null","waktu":"string|null","keyword":"string|null","pesan":"string|null","periode":"string|null","waktu_transaksi":"string|null"}';

  return await panggilGroqJson(systemPrompt, userPrompt, 300);
}

function fmt(x) {
  const n = Number(x) || 0;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

async function updateSaldo(rekening, amt, type) {
  const rekLower = rekening.toLowerCase();
  const [rows] = await db.query('SELECT saldo FROM bot_rekening WHERE LOWER(nama) = ?', [rekLower]);
  
  if (rows.length > 0) {
    const current = Number(rows[0].saldo) || 0;
    const newSaldo = type === "Masuk" ? current + amt : current - amt;
    await db.query('UPDATE bot_rekening SET saldo = ? WHERE LOWER(nama) = ?', [newSaldo, rekLower]);
    return newSaldo;
  } else {
    const initial = type === "Masuk" ? amt : -amt;
    await db.query('INSERT INTO bot_rekening (nama, saldo) VALUES (?, ?)', [rekening, initial]);
    return initial;
  }
}

async function getSaldo(rekening) {
  const [rows] = await db.query('SELECT saldo FROM bot_rekening WHERE LOWER(nama) = ?', [rekening.toLowerCase()]);
  return rows.length > 0 ? Number(rows[0].saldo) : 0;
}

async function prosesTransaksi(ai) {
  if (!ai.cat || ai.amt === null || ai.amt === undefined) {
    return "⚠️ Tidak bisa memahami transaksinya. Coba format: 'beli makan 25000 cash'";
  }
  const rekening = (ai.rek || "Cash").trim();

  // Gunakan waktu yang disebutkan user, atau NOW jika tidak disebutkan
  let waktuTransaksi;
  if (ai.waktu_transaksi) {
    const parsed = new Date(ai.waktu_transaksi.replace(' ', 'T') + ':00');
    waktuTransaksi = isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    waktuTransaksi = new Date();
  }
  const mysqlWaktu = waktuTransaksi.toISOString().slice(0, 19).replace('T', ' ');

  await db.query(
    'INSERT INTO bot_transaksi (pesan, kategori, jumlah, tipe, rekening, waktu_transaksi) VALUES (?, ?, ?, ?, ?, ?)',
    [ai.pesan || "-", ai.cat, ai.amt, ai.type, rekening, mysqlWaktu]
  );

  const saldoKini = await updateSaldo(rekening, ai.amt, ai.type);

  // Sync to Google Sheets (fire and forget)
  syncToGoogleSheets({
    token:            process.env.GOOGLE_SHEET_TOKEN || '',
    waktu_transaksi:  mysqlWaktu,
    kategori:         ai.cat,
    nominal:          ai.amt,
    tipe:             ai.type,
    rekening:         rekening,
    keterangan:       ai.pesan || '-'
  });

  return (
    "📝 *Transaksi Tercatat*\n━━━━━━━━━━━━━━━━━━\n" +
    `📂 Kategori  : ${ai.cat}\n` +
    `💰 Jumlah    : Rp ${fmt(ai.amt)}\n` +
    `💳 Rekening  : ${rekening} (Rp ${fmt(saldoKini)})\n` +
    `↔️ Tipe      : ${ai.type}\n` +
    "━━━━━━━━━━━━━━━━━━\n✅ Berhasil disimpan"
  );
}

async function setSaldo(namaRekening, nominalBaru) {
  // Cek apakah rekening ada
  const [existing] = await db.query('SELECT nama, saldo FROM bot_rekening WHERE LOWER(nama) = ?', [namaRekening.toLowerCase()]);
  
  if (existing.length === 0) {
    // Buat rekening baru jika belum ada
    await db.query('INSERT INTO bot_rekening (nama, saldo) VALUES (?, ?)', [namaRekening, nominalBaru]);
  } else {
    // Update saldo yang ada
    await db.query('UPDATE bot_rekening SET saldo = ? WHERE LOWER(nama) = ?', [nominalBaru, namaRekening.toLowerCase()]);
  }

  // Sync ke Google Sheets
  syncToGoogleSheets({
    token:           process.env.GOOGLE_SHEET_TOKEN || '',
    action:          'set_saldo',
    rekening:        namaRekening,
    saldo:           nominalBaru,
    waktu_transaksi: new Date().toISOString().slice(0, 16).replace('T', ' '),
    kategori:        'Koreksi Saldo',
    nominal:         nominalBaru,
    tipe:            'Koreksi',
    keterangan:      `Set saldo ${namaRekening} = ${nominalBaru}`
  });

  return `✅ *Saldo ${namaRekening} diperbarui*\nSaldo baru: Rp ${fmt(nominalBaru)}`;
}

async function getAllSaldo() {
  const [rows] = await db.query('SELECT nama, saldo FROM bot_rekening ORDER BY nama ASC');
  if (rows.length === 0) return "ℹ️ Belum ada saldo tercatat.";

  let output = "💰 *Ringkasan Saldo*\n━━━━━━━━━━━━━━━━━━\n";
  let total = 0;
  for (const row of rows) {
    const saldo = Number(row.saldo) || 0;
    output += `${saldo >= 0 ? "▪️" : "🔴"} ${row.nama}: Rp ${fmt(saldo)}\n`;
    total += saldo;
  }
  output += `━━━━━━━━━━━━━━━━━━\n💼 *Total: Rp ${fmt(total)}*`;
  return output;
}

async function getLaporan(periode, rek) {
  let rows, label, sql, params = [];

  if (rek) {
    sql = 'SELECT kategori, jumlah, tipe FROM bot_transaksi WHERE LOWER(rekening) = ? AND MONTH(waktu_transaksi) = MONTH(CURRENT_DATE()) AND YEAR(waktu_transaksi) = YEAR(CURRENT_DATE()) ORDER BY waktu_transaksi DESC';
    params = [rek.toLowerCase()];
    label = `rekening ${rek} (bulan ini)`;
  } else if (periode === 'harian') {
    sql = 'SELECT kategori, jumlah, tipe FROM bot_transaksi WHERE DATE(waktu_transaksi) = CURDATE() ORDER BY waktu_transaksi DESC';
    label = 'hari ini';
  } else if (periode === 'mingguan') {
    sql = 'SELECT kategori, jumlah, tipe FROM bot_transaksi WHERE waktu_transaksi >= DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY waktu_transaksi DESC';
    label = '7 hari terakhir';
  } else {
    sql = 'SELECT kategori, jumlah, tipe FROM bot_transaksi WHERE MONTH(waktu_transaksi) = MONTH(CURRENT_DATE()) AND YEAR(waktu_transaksi) = YEAR(CURRENT_DATE()) ORDER BY waktu_transaksi DESC';
    label = 'bulan ini';
  }

  [rows] = await db.query(sql, params);

  if (rows.length === 0) return `ℹ️ Belum ada transaksi untuk ${label}.`;

  let masuk = 0, keluar = 0;
  for (const row of rows) {
    const jumlah = Number(row.jumlah) || 0;
    if (row.tipe === 'Masuk') masuk += jumlah; else keluar += jumlah;
  }

  const recent = rows.slice(0, 5).map(r => `• ${r.kategori} (${r.tipe}): Rp ${fmt(r.jumlah)}`);

  return (
    `📊 *Laporan ${label}*\n━━━━━━━━━━━━━━━━━━\n` +
    `📥 Masuk : Rp ${fmt(masuk)}\n📤 Keluar: Rp ${fmt(keluar)}\n` +
    `💹 Selisih: Rp ${fmt(masuk - keluar)}\n━━━━━━━━━━━━━━━━━━\n` +
    `📋 *5 Transaksi Terakhir:*\n${recent.join('\n')}`
  );
}

async function tambahReminder(ai) {
  if (!ai.isi || !ai.waktu) {
    return "⚠️ Gak nangkep waktunya. Coba: 'ingetin besok jam 7 pagi meeting'";
  }
  const waktuStr = ai.waktu.replace(" ", "T") + ":00";
  const waktu = new Date(waktuStr);
  if (isNaN(waktu.getTime())) {
    return "⚠️ Format waktu gak valid. Coba sebutkan waktu lebih jelas.";
  }

  const mysqlTime = waktu.toISOString().slice(0, 19).replace('T', ' ');

  await db.query(
    'INSERT INTO bot_reminder (isi, waktu, status) VALUES (?, ?, ?)',
    [ai.isi, mysqlTime, 'Pending']
  );

  const options = { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  const waktuLokal = waktu.toLocaleString('id-ID', options);
  
  return `⏰ Reminder disimpan!\n"${ai.isi}"\n📅 ${waktuLokal} WIB`;
}

async function listReminder() {
  const [rows] = await db.query('SELECT isi, waktu FROM bot_reminder WHERE status = "Pending" ORDER BY waktu ASC');
  if (rows.length === 0) return "✅ Gak ada reminder yang pending. Kamu bebas!";

  const pending = rows.map(r => {
    const waktuStr = new Date(r.waktu).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `• ${r.isi} (${waktuStr})`;
  });

  return `⏰ *Reminder Aktif*\n━━━━━━━━━━━━━━━━━━\n${pending.join("\n")}`;
}

async function selesaiReminder(ai) {
  if (!ai.keyword) return "ℹ️ Reminder tidak ditemukan.";
  
  const kw = `%${ai.keyword.toLowerCase()}%`;
  const [rows] = await db.query('SELECT id, isi FROM bot_reminder WHERE status = "Pending" AND LOWER(isi) LIKE ? LIMIT 1', [kw]);
  
  if (rows.length > 0) {
    await db.query('UPDATE bot_reminder SET status = "Selesai" WHERE id = ?', [rows[0].id]);
    return `✅ Reminder "${rows[0].isi}" ditandai selesai.`;
  }
  
  return `ℹ️ Gak nemu reminder pending yang cocok dengan "${ai.keyword}".`;
}

async function jawabChatBebas(pertanyaan) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return "❌ GROQ_API_KEY belum diset.";

  const systemPrompt =
    "Kamu adalah asisten pribadi yang ramah, singkat, dan membantu. " +
    "Jawab dalam Bahasa Indonesia yang santai tapi jelas.";

  const payload = {
    model: "llama3-70b-8192",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: pertanyaan }
    ],
    temperature: 0.6,
    max_tokens: 500
  };

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json" 
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!result.choices || !result.choices[0]) return "❌ AI gagal merespons.";
  return result.choices[0].message.content.trim();
}

async function eksekusiIntent(intent, pesanAsli) {
  switch (intent.intent) {
    case "transaksi_keuangan": return await prosesTransaksi(intent);
    case "cek_saldo":          return await getAllSaldo();
    case "atur_saldo":         return await setSaldo(intent.rek || 'Cash', intent.amt || 0);
    case "laporan_keuangan":   return await getLaporan(intent.periode || 'bulanan', intent.rek || null);
    case "tambah_reminder":    return await tambahReminder(intent);
    case "list_reminder":      return await listReminder();
    case "selesai_reminder":   return await selesaiReminder(intent);
    case "chat_bebas":
    default:
      return await jawabChatBebas(intent.pesan || pesanAsli);
  }
}

async function processBotMessage(pesan) {
  // Perintah set saldo — berbagai variasi yang didukung:
  // "set saldo cash 97000"
  // "koreksi saldo cash 97000"
  // "ubah saldo cash 97000"
  // "saldo cash sekarang 97000"
  // "cash 97000 sekarang"
  const setSaldoMatch =
    pesan.trim().match(/^(?:set|ubah|koreksi|update)\s+saldo\s+(\w+)\s+([\d.,]+)/i) ||
    pesan.trim().match(/^saldo\s+(\w+)\s+(?:sekarang|jadi|=|adalah)\s+([\d.,]+)/i) ||
    pesan.trim().match(/^(\w+)\s+([\d.,]+)\s+(?:sekarang|jadi)/i);
  if (setSaldoMatch) {
    const namaRek = setSaldoMatch[1];
    const rawNum  = setSaldoMatch[2].replace(/\./g, '').replace(/,/g, '.');
    const nominal = parseFloat(rawNum);
    // Pastikan bukan salah tangkap (minimal nama rekening 2 huruf)
    if (!isNaN(nominal) && namaRek.length >= 2) {
      return await setSaldo(namaRek, nominal);
    }
  }

  if (/^(help|bantuan)$/i.test(pesan.trim())) {
    return (
      "*Asisten Pribadi*\n━━━━━━━━━━━━━━━━━━\n" +
      "*Keuangan:*\n  • beli makan 25000\n  • saldo\n  • laporan bulan ini\n\n" +
      "*Koreksi Saldo:*\n  • set saldo cash 97000\n  • set saldo BCA 500000\n\n" +
      "*Reminder:*\n  • ingetin besok jam 7 pagi meeting\n  • list reminder\n\n" +
      "*Chat Bebas:*\n  • tanya apa aja, langsung dijawab AI\n\n" +
      "━━━━━━━━━━━━━━━━━━"
    );
  }

  try {
    const intent = await deteksiIntent(pesan);
    return await eksekusiIntent(intent, pesan);
  } catch (err) {
    console.error("AI Error:", err);
    return `❌ Terjadi kesalahan AI: ${err.message}`;
  }
}

module.exports = {
  processBotMessage
};
