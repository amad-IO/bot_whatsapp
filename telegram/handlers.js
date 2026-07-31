const path = require('path');
const fs = require('fs');
const db = require('../db');
const { setState, getState, clearState } = require('./state');
const { parseReceipt, chatWithContext } = require('./gemini');

async function syncToGoogleSheets(data) {
  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow'
    });
  } catch (err) {
    console.error('Google Sheet Sync Error:', err);
  }
}

function formatWaNumber(num) {
    let clean = num.replace(/\D/g, '');
    if (clean.startsWith('0')) clean = '62' + clean.substring(1);
    else if (clean.startsWith('8')) clean = '62' + clean;
    return clean;
}

function handleStart(bot, msg) {
    const chatId = msg.chat.id;
    clearState(chatId);
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Tambah Kontak', callback_data: 'add_kontak' }, { text: '👥 Daftar Kontak', callback_data: 'view_contacts' }],
                [{ text: '🖼️ Upload QRIS', callback_data: 'upload_qris' }, { text: '💳 Lihat QRIS', callback_data: 'view_qris' }],
                [{ text: '🧾 Mulai Split Bill', callback_data: 'split_bill' }]
            ]
        }
    };
    bot.sendMessage(chatId, "🎉 Selamat datang di Bot Asisten Timo (Telegram)!\n\nSilakan pilih menu di bawah ini atau ketik /cancel untuk membatalkan proses yang sedang berjalan:", options);
}

async function handleMessage(bot, msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return; // Abaikan jika bukan teks

    if (text.toLowerCase() === '/cancel') {
        clearState(chatId);
        return bot.sendMessage(chatId, "✅ Operasi dibatalkan. Anda bisa mulai dari awal.");
    }

    const state = getState(chatId);

    if (state.step === 'WAIT_CONTACT') {
        const splitIndex = text.indexOf('-');
        if (splitIndex === -1) {
            return bot.sendMessage(chatId, "❌ Format salah. Gunakan format:\nNama - Nomor WA\n(Contoh: Budi - 08123456789)");
        }
        const nama = text.substring(0, splitIndex).trim();
        const nomor = formatWaNumber(text.substring(splitIndex + 1));
        if (!nomor) return bot.sendMessage(chatId, "❌ Nomor tidak valid.");

        try {
            const [existing] = await db.query('SELECT nama FROM bot_kontak WHERE nomor = ?', [nomor]);
            if (existing && existing.length > 0) {
                setState(chatId, { step: 'WAIT_DUPLICATE_DECISION', tempName: nama, tempNumber: nomor });
                const opts = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Ganti Nama', callback_data: 'dup_replace' }],
                            [{ text: '❌ Cancel', callback_data: 'dup_cancel' }]
                        ]
                    }
                };
                return bot.sendMessage(chatId, `Nomor ini sudah tersimpan atas nama *${existing[0].nama}*.`, { parse_mode: 'Markdown', ...opts });
            }

            await db.query('INSERT INTO bot_kontak (nama, nomor) VALUES (?, ?)', [nama, nomor]);
            await syncToGoogleSheets({ 
                token: process.env.GOOGLE_SHEET_TOKEN || '',
                action: 'kontak_baru',
                nomor: nomor, 
                nama: nama 
            });
            clearState(chatId);
            bot.sendMessage(chatId, `✅ Kontak ${nama} (${nomor}) berhasil disimpan & disinkronisasi ke Google Sheet.`);
        } catch (e) {
            console.error('DB Error:', e);
            bot.sendMessage(chatId, `❌ Terjadi kesalahan: ${e.message}`);
        }
    } else if (state.step === 'WAIT_QRIS_NAME') {
        setState(chatId, { step: 'WAIT_QRIS_PHOTO', qrisName: text.trim() });
        bot.sendMessage(chatId, `Nama Rekening "${text.trim()}" disimpan.\n📷 Sekarang silakan kirim gambar QRIS-nya.`);
    } else if (!state.step && !text.startsWith('/')) {
        // Chat bebas ke Gemini
        bot.sendMessage(chatId, "⏳ Berpikir...");
        try {
            const [kontaks] = await db.query('SELECT nama, nomor FROM bot_kontak ORDER BY created_at DESC LIMIT 25');
            const [qris] = await db.query('SELECT id, nama_rekening FROM bot_qris');
            
            const reply = await chatWithContext(text, kontaks, qris);
            
            const match = reply.match(/\[TAMPILKAN_QRIS_ID_(\d+)\]/);
            if (match) {
                const qrisId = match[1];
                const cleanReply = reply.replace(match[0], '').trim();
                if (cleanReply) await bot.sendMessage(chatId, cleanReply);
                
                const [qData] = await db.query('SELECT * FROM bot_qris WHERE id = ?', [qrisId]);
                let actualPath = '';
                if (qData && qData.length > 0) {
                    actualPath = path.join(__dirname, '..', 'qris_images', path.basename(qData[0].file_path));
                }
                if (actualPath && fs.existsSync(actualPath)) {
                    bot.sendPhoto(chatId, fs.createReadStream(actualPath), { caption: `QRIS: ${qData[0].nama_rekening}` });
                } else {
                    bot.sendMessage(chatId, "❌ File QRIS tidak ditemukan di server.");
                }
            } else {
                bot.sendMessage(chatId, reply);
            }
        } catch (e) {
            console.error('Gemini error:', e);
            bot.sendMessage(chatId, "❌ Maaf, AI sedang mengalami gangguan: " + e.message);
        }
    }
}

async function handlePhoto(bot, msg) {
    const chatId = msg.chat.id;
    const state = getState(chatId);

    if (state.step === 'WAIT_QRIS_PHOTO') {
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const qrisDir = path.join(__dirname, '..', 'qris_images');
            if (!fs.existsSync(qrisDir)) {
                fs.mkdirSync(qrisDir, { recursive: true });
            }
            const filePath = await bot.downloadFile(fileId, qrisDir);
            
            await db.query('INSERT INTO bot_qris (nama_rekening, file_path) VALUES (?, ?)', [state.qrisName, filePath]);
            clearState(chatId);
            bot.sendMessage(chatId, `✅ QRIS "${state.qrisName}" berhasil disimpan!`);
        } catch (e) {
            console.error('Error saat menyimpan QRIS:', e);
            bot.sendMessage(chatId, `❌ Terjadi kesalahan: ${e.message}`);
        }
    } else if (state.step === 'WAIT_RECEIPT') {
        bot.sendMessage(chatId, "⏳ Sedang memproses struk dengan Gemini AI, mohon tunggu...");
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        
        try {
            const file = await bot.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
            
            const response = await fetch(fileUrl);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64Image = buffer.toString('base64');
            const mimeType = 'image/jpeg'; 

            const result = await parseReceipt(base64Image, mimeType);
            
            if (!result.is_readable || !result.items || result.items.length === 0) {
                bot.sendMessage(chatId, "❌ Gambar tidak terbaca atau struk terlalu buram. Mohon kirim ulang foto yang lebih jelas.");
                return;
            }

            // PECAH ITEM JIKA QTY > 1
            let expandedItems = [];
            result.items.forEach(item => {
                const q = parseInt(item.qty) || 1;
                if (q > 1) {
                    const splitSubtotal = item.subtotal / q;
                    for (let i = 0; i < q; i++) {
                        expandedItems.push({
                            qty: 1,
                            nama_barang: item.nama_barang,
                            harga_satuan: item.harga_satuan,
                            subtotal: splitSubtotal
                        });
                    }
                } else {
                    expandedItems.push(item);
                }
            });
            result.items = expandedItems;

            let textMsg = "🧾 *Hasil Ekstraksi Struk:*\n\n";
            result.items.forEach((item, index) => {
                textMsg += `▪️ *${item.nama_barang}*\n      ${item.qty} x Rp ${item.harga_satuan.toLocaleString('id-ID')} = *Rp ${item.subtotal.toLocaleString('id-ID')}*\n`;
            });
            textMsg += `\n💰 *Total: Rp ${result.total.toLocaleString('id-ID')}*\n\nApakah data ini sudah benar?`;

            setState(chatId, { ...state, step: 'CONFIRM_RECEIPT', parsedData: result });

            const options = {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Ya, Benar', callback_data: 'confirm_receipt_yes' }],
                        [{ text: '❌ Ulangi (Kirim Struk Lain)', callback_data: 'lanjut_kirim_struk' }]
                    ]
                }
            };
            bot.sendMessage(chatId, textMsg, options);
        } catch (e) {
            console.error('Gemini/Bot error:', e);
            bot.sendMessage(chatId, "❌ Terjadi kesalahan saat memproses gambar: " + e.message);
        }
    }
}

function getParticipantKeyboard(kontaks, selectedParts) {
    let buttons = [];
    kontaks.forEach(k => {
        const isSelected = selectedParts.includes(k.nomor);
        const text = isSelected ? `✅ ${k.nama}` : `❌ ${k.nama}`;
        buttons.push([{ text, callback_data: `toggle_participant_${k.nomor}` }]);
    });
    
    // Format 2 cols
    let formattedButtons = [];
    for(let i=0; i<buttons.length; i+=2){
        if(buttons[i+1]) formattedButtons.push([buttons[i][0], buttons[i+1][0]]);
        else formattedButtons.push([buttons[i][0]]);
    }
    formattedButtons.push([{ text: '➡️ Lanjut Kirim Struk', callback_data: 'lanjut_kirim_struk' }]);
    return { inline_keyboard: formattedButtons };
}

async function handleCallbackQuery(bot, query) {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'add_kontak') {
        setState(chatId, { step: 'WAIT_CONTACT' });
        bot.sendMessage(chatId, "Silakan balas pesan ini dengan format:\nNama - Nomor WA\nContoh: Budi - 08123456789");
    } else if (data === 'upload_qris') {
        setState(chatId, { step: 'WAIT_QRIS_NAME' });
        bot.sendMessage(chatId, "Silakan ketik nama rekening/bank untuk QRIS ini (contoh: BCA Ahmad):");
    } else if (data === 'view_contacts') {
        const [rows] = await db.query('SELECT nama, nomor FROM bot_kontak ORDER BY created_at DESC LIMIT 25');
        if (rows.length === 0) {
            bot.sendMessage(chatId, "Belum ada kontak yang tersimpan.");
        } else {
            let msg = "📋 *25 Kontak Terakhir:*\n\n";
            rows.forEach((r, i) => { msg += `${i+1}. ${r.nama} - ${r.nomor}\n`; });
            bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }
    } else if (data === 'view_qris') {
        const [rows] = await db.query('SELECT id, nama_rekening FROM bot_qris ORDER BY id DESC');
        if (rows.length === 0) {
            bot.sendMessage(chatId, "Belum ada QRIS yang tersimpan.");
        } else {
            let buttons = [];
            rows.forEach(r => { buttons.push([{ text: `💳 ${r.nama_rekening}`, callback_data: `show_qris_${r.id}` }]); });
            buttons.push([{ text: '❌ Batal', callback_data: 'cancel_view_qris' }]);
            bot.sendMessage(chatId, "Pilih QRIS yang ingin dilihat:", { reply_markup: { inline_keyboard: buttons } });
        }
    } else if (data === 'cancel_view_qris') {
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
    } else if (data.startsWith('show_qris_')) {
        const qId = data.replace('show_qris_', '');
        const [qris] = await db.query('SELECT * FROM bot_qris WHERE id = ?', [qId]);
        let actualPath = '';
        if (qris && qris.length > 0) {
            actualPath = path.join(__dirname, '..', 'qris_images', path.basename(qris[0].file_path));
        }
        if (actualPath && fs.existsSync(actualPath)) {
            bot.sendPhoto(chatId, fs.createReadStream(actualPath), { caption: `QRIS: ${qris[0].nama_rekening}` });
        } else {
            bot.sendMessage(chatId, "❌ File QRIS tidak ditemukan di server.");
        }
    } else if (data === 'dup_replace') {
        const state = getState(chatId);
        if (state.tempName && state.tempNumber) {
            await db.query('UPDATE bot_kontak SET nama = ? WHERE nomor = ?', [state.tempName, state.tempNumber]);
            await syncToGoogleSheets({ 
                token: process.env.GOOGLE_SHEET_TOKEN || '',
                action: 'kontak_baru',
                nomor: state.tempNumber, 
                nama: state.tempName 
            });
            bot.sendMessage(chatId, `✅ Kontak berhasil diperbarui menjadi ${state.tempName} (${state.tempNumber}).`);
        }
        clearState(chatId);
    } else if (data === 'dup_cancel') {
        clearState(chatId);
        bot.sendMessage(chatId, `❌ Penambahan kontak dibatalkan.`);
    } else if (data === 'split_bill') {
        const [kontaks] = await db.query('SELECT nama, nomor FROM bot_kontak ORDER BY created_at DESC');
        if (kontaks.length === 0) {
            return bot.sendMessage(chatId, "❌ Anda belum memiliki kontak. Silakan /start dan tambah kontak dulu.");
        }
        setState(chatId, { step: 'SELECT_PARTICIPANTS', participants: [] });
        bot.sendMessage(chatId, "👥 *Pilih Partisipan yang Ikut Makan:*\nKlik nama untuk memilih/membatalkan. Jika sudah selesai memilih, klik *Lanjut Kirim Struk*.", {
            parse_mode: 'Markdown',
            reply_markup: getParticipantKeyboard(kontaks, [])
        });
    } else if (data.startsWith('toggle_participant_')) {
        const nomor = data.replace('toggle_participant_', '');
        const state = getState(chatId);
        if (state.step !== 'SELECT_PARTICIPANTS') return;
        
        let parts = state.participants || [];
        if (parts.includes(nomor)) {
            parts = parts.filter(n => n !== nomor);
        } else {
            parts.push(nomor);
        }
        setState(chatId, { ...state, participants: parts });
        
        const [kontaks] = await db.query('SELECT nama, nomor FROM bot_kontak ORDER BY created_at DESC');
        bot.editMessageReplyMarkup(getParticipantKeyboard(kontaks, parts), {
            chat_id: chatId,
            message_id: query.message.message_id
        }).catch(()=>{});
    } else if (data === 'lanjut_kirim_struk') {
        const state = getState(chatId);
        setState(chatId, { ...state, step: 'WAIT_RECEIPT' });
        // Hapus pesan menu partisipan agar tidak numpuk
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
        bot.sendMessage(chatId, "📸 *Pilihan disimpan!*\nSekarang silakan kirimkan foto struk belanja Anda.", { parse_mode: 'Markdown' });
    } else if (data === 'confirm_receipt_yes') {
        const state = getState(chatId);
        if (!state.parsedData || !state.parsedData.items) {
            bot.sendMessage(chatId, "⚠️ Sesi Anda telah berakhir (mungkin karena server direstart). Silakan kirim ulang foto struk Anda.");
            return;
        }
        showAssignMenu(bot, chatId, state.parsedData);
    } else if (data.startsWith('assign_item_')) {
        const index = parseInt(data.replace('assign_item_', ''));
        const state = getState(chatId);
        const item = state.parsedData.items[index];
        
        const [kontaks] = await db.query('SELECT nama, nomor FROM bot_kontak'); 
        const selectedParts = state.participants || [];
        
        let buttons = [];
        buttons.push([{ text: '🙋‍♂️ Saya Sendiri', callback_data: `assign_contact_self_${index}` }]);
        
        kontaks.forEach(k => {
            if (selectedParts.includes(k.nomor)) {
                buttons.push([{ text: `👤 ${k.nama}`, callback_data: `assign_contact_${k.nomor}_${index}` }]);
            }
        });
        
        let formattedButtons = [];
        for(let i=0; i<buttons.length; i+=2){
             if(buttons[i+1]) formattedButtons.push([buttons[i][0], buttons[i+1][0]]);
             else formattedButtons.push([buttons[i][0]]);
        }
        formattedButtons.push([{ text: '🔙 Kembali', callback_data: 'back_to_assign' }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: formattedButtons } };
        bot.sendMessage(chatId, `Pilih partisipan untuk membayar:\n*${item.qty}x ${item.nama_barang} (Rp ${item.subtotal.toLocaleString('id-ID')})*`, options);

    } else if (data.startsWith('assign_contact_')) {
        const parts = data.replace('assign_contact_', '').split('_');
        const nomor = parts[0]; 
        const index = parseInt(parts[1]);
        
        const state = getState(chatId);
        if(!state.assignments) state.assignments = {};
        state.assignments[index] = nomor;
        setState(chatId, { ...state, assignments: state.assignments });
        
        // Hapus menu pemilihan agar chat rapi
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
        showAssignMenu(bot, chatId, state.parsedData);
        
    } else if (data === 'back_to_assign') {
        const state = getState(chatId);
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
        showAssignMenu(bot, chatId, state.parsedData);
    } else if (data === 'go_to_qris') {
        const [rows] = await db.query('SELECT id, nama_rekening FROM bot_qris ORDER BY id DESC');
        if (rows.length === 0) {
            bot.sendMessage(chatId, "⚠️ Anda belum mendaftarkan satupun QRIS. Silakan /start dan Upload QRIS terlebih dahulu.");
            return;
        }

        let buttons = [];
        rows.forEach(r => {
            buttons.push([{ text: r.nama_rekening, callback_data: `select_qris_${r.id}` }]);
        });

        const options = { reply_markup: { inline_keyboard: buttons } };
        bot.sendMessage(chatId, "Pilih QRIS yang ingin dilampirkan pada tagihan ini:", options);

    } else if (data.startsWith('select_qris_')) {
        const qrisId = data.replace('select_qris_', '');
        setState(chatId, { ...getState(chatId), selectedQris: qrisId });
        bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
        finishSplitBill(bot, chatId);
    }

    try { bot.answerCallbackQuery(query.id); } catch(e){}
}

function showAssignMenu(bot, chatId, parsedData) {
    const state = getState(chatId);
    const assignments = state.assignments || {};
    
    let textMsg = "🛒 *Penugasan Barang*\n\n";
    let buttons = [];
    
    let allAssigned = true;
    
    parsedData.items.forEach((item, index) => {
        const assignedTo = assignments[index];
        let status = "❌ Belum di-assign";
        if (assignedTo === 'self') status = "🙋‍♂️ Saya Sendiri";
        else if (assignedTo) status = `👤 ${assignedTo}`;
        else allAssigned = false;
        
        textMsg += `${index+1}. ${item.nama_barang} (Rp ${item.subtotal.toLocaleString('id-ID')}) - ${status}\n`;
        buttons.push([{ text: `Assign ${index+1}`, callback_data: `assign_item_${index}` }]);
    });
    
    // Format buttons 3 per row
    let formattedButtons = [];
    for(let i=0; i<buttons.length; i+=3){
        let row = [buttons[i][0]];
        if(buttons[i+1]) row.push(buttons[i+1][0]);
        if(buttons[i+2]) row.push(buttons[i+2][0]);
        formattedButtons.push(row);
    }

    if (allAssigned) {
        formattedButtons.push([{ text: '✅ Lanjut Pilih QRIS', callback_data: 'go_to_qris' }]);
    }

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: formattedButtons } };
    
    // Kalau sebelumnya sudah ada assign menu, lebih baik kirim baru agar posisinya di bawah
    bot.sendMessage(chatId, textMsg, options);
}

async function finishSplitBill(bot, chatId) {
    const state = getState(chatId);
    const parsedData = state.parsedData;
    const assignments = state.assignments;
    const qrisId = state.selectedQris;
    
    bot.sendMessage(chatId, "⏳ Memproses tagihan & mengirim broadcast WA...");
    
    try {
        const [qris] = await db.query('SELECT * FROM bot_qris WHERE id = ?', [qrisId]);
        let actualPath = '';
        if(qris && qris.length > 0) {
            actualPath = path.join(__dirname, '..', 'qris_images', path.basename(qris[0].file_path));
        }
        
        const [sbResult] = await db.query('INSERT INTO bot_splitbill (total, bot_qris_id, status) VALUES (?, ?, ?)', [parsedData.total, qrisId, 'Selesai']);
        const sbId = sbResult.insertId;
        
        let hutangPerOrang = {}; 
        
        for (let index = 0; index < parsedData.items.length; index++) {
            const item = parsedData.items[index];
            const nomor = assignments[index];
            
            await db.query('INSERT INTO bot_splitbill_items (splitbill_id, qty, nama_barang, harga_satuan, subtotal, wa_nomor_partisipan) VALUES (?, ?, ?, ?, ?, ?)', 
            [sbId, item.qty, item.nama_barang, item.harga_satuan, item.subtotal, nomor === 'self' ? 'Saya Sendiri' : nomor]);
            
            if (nomor !== 'self') {
                if(!hutangPerOrang[nomor]) hutangPerOrang[nomor] = { items: [], total: 0 };
                hutangPerOrang[nomor].items.push(item);
                hutangPerOrang[nomor].total += item.subtotal;
            }
        }
        
        let qrisBase64 = null;
        let qrisMime = 'image/jpeg';
        let qrisFileName = 'qris.jpg';
        if (actualPath && fs.existsSync(actualPath)) {
            qrisBase64 = fs.readFileSync(actualPath).toString('base64');
            qrisFileName = path.basename(actualPath);
            if (qrisFileName.endsWith('.png')) qrisMime = 'image/png';
        }
        
        let staffId = 'bot'; // Session WA utama
        
        for (const nomor in hutangPerOrang) {
            const tagihan = hutangPerOrang[nomor];
            let caption = `Halo! Ini rincian patungan / Split Bill kamu:\n\n`;
            tagihan.items.forEach(it => {
                caption += `- ${it.qty}x ${it.nama_barang}: Rp ${it.subtotal.toLocaleString('id-ID')}\n`;
            });
            caption += `\n*Total Tagihan: Rp ${tagihan.total.toLocaleString('id-ID')}*\n\nSilakan transfer ke QRIS berikut ya, terima kasih! 🙏`;
            
            if (qrisBase64) {
                await db.query('INSERT INTO wa_outgoing (staff_id, wa_number, message, file_name, file_mime, file_data, msg_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [staffId, nomor, caption, qrisFileName, qrisMime, qrisBase64, 'file', 'pending']);
            } else {
                await db.query('INSERT INTO wa_outgoing (staff_id, wa_number, message, msg_type, status) VALUES (?, ?, ?, ?, ?)',
                [staffId, nomor, caption, 'text', 'pending']);
            }
        }
        
        clearState(chatId);
        bot.sendMessage(chatId, "✅ Rincian tagihan berhasil dibuat dan dimasukkan ke antrean Broadcast WhatsApp!");
        
    } catch (e) {
        console.error('Error finishing split bill:', e);
        bot.sendMessage(chatId, "❌ Terjadi kesalahan saat memproses tagihan: " + e.message);
    }
}

module.exports = { handleStart, handleMessage, handleCallbackQuery, handlePhoto };
