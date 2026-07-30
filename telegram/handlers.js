const path = require('path');
const fs = require('fs');
const db = require('../db');
const { setState, getState, clearState } = require('./state');
const { parseReceipt } = require('./gemini');

function handleStart(bot, msg) {
    const chatId = msg.chat.id;
    clearState(chatId);
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Tambah Kontak', callback_data: 'add_kontak' }],
                [{ text: '🖼️ Upload QRIS', callback_data: 'upload_qris' }],
                [{ text: '🧾 Mulai Split Bill', callback_data: 'split_bill' }]
            ]
        }
    };
    bot.sendMessage(chatId, "🎉 Selamat datang di Bot Asisten Timo (Telegram)!\n\nSilakan pilih menu di bawah ini:", options);
}

async function handleMessage(bot, msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const state = getState(chatId);

    if (state.step === 'WAIT_CONTACT') {
        const parts = text.split('-');
        if (parts.length < 2) {
            return bot.sendMessage(chatId, "❌ Format salah. Gunakan format:\nNama - Nomor WA\n(Contoh: Budi - 08123456789)");
        }
        const nama = parts[0].trim();
        const nomor = parts[1].trim().replace(/\D/g, '');
        if (!nomor) return bot.sendMessage(chatId, "❌ Nomor tidak valid.");

        await db.query('INSERT INTO bot_kontak (nama, nomor) VALUES (?, ?) ON DUPLICATE KEY UPDATE nama = ?', [nama, nomor, nama]);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Kontak ${nama} (${nomor}) berhasil disimpan.`);
    } else if (state.step === 'WAIT_QRIS_NAME') {
        setState(chatId, { step: 'WAIT_QRIS_PHOTO', qrisName: text.trim() });
        bot.sendMessage(chatId, `Nama Rekening "${text.trim()}" disimpan.\n📷 Sekarang silakan kirim gambar QRIS-nya.`);
    }
}

async function handlePhoto(bot, msg) {
    const chatId = msg.chat.id;
    const state = getState(chatId);

    if (state.step === 'WAIT_QRIS_PHOTO') {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const qrisDir = path.join(__dirname, '..', 'qris_images');
        const filePath = await bot.downloadFile(fileId, qrisDir);
        
        await db.query('INSERT INTO bot_qris (nama_rekening, file_path) VALUES (?, ?)', [state.qrisName, filePath]);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ QRIS "${state.qrisName}" berhasil disimpan!`);
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

            let textMsg = "🧾 *Hasil Ekstraksi Struk:*\n\n";
            result.items.forEach((item, index) => {
                textMsg += `${index+1}. ${item.qty}x ${item.nama_barang} @ Rp ${item.harga_satuan.toLocaleString('id-ID')} = Rp ${item.subtotal.toLocaleString('id-ID')}\n`;
            });
            textMsg += `\n*Total: Rp ${result.total.toLocaleString('id-ID')}*\n\nApakah data ini sudah benar?`;

            setState(chatId, { step: 'CONFIRM_RECEIPT', parsedData: result });

            const options = {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Ya, Benar', callback_data: 'confirm_receipt_yes' }],
                        [{ text: '❌ Ulangi (Kirim Struk Lain)', callback_data: 'split_bill' }]
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

async function handleCallbackQuery(bot, query) {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'add_kontak') {
        setState(chatId, { step: 'WAIT_CONTACT' });
        bot.sendMessage(chatId, "Silakan balas pesan ini dengan format:\nNama - Nomor WA\nContoh: Budi - 08123456789");
    } else if (data === 'upload_qris') {
        setState(chatId, { step: 'WAIT_QRIS_NAME' });
        bot.sendMessage(chatId, "Silakan ketik nama rekening/bank untuk QRIS ini (contoh: BCA Ahmad):");
    } else if (data === 'split_bill') {
        setState(chatId, { step: 'WAIT_RECEIPT' });
        bot.sendMessage(chatId, "📸 Silakan kirimkan foto struk belanja Anda.");
    } else if (data === 'confirm_receipt_yes') {
        const state = getState(chatId);
        showAssignMenu(bot, chatId, state.parsedData);
    } else if (data.startsWith('assign_item_')) {
        const index = parseInt(data.replace('assign_item_', ''));
        const state = getState(chatId);
        const item = state.parsedData.items[index];
        
        const [kontaks] = await db.query('SELECT nama, nomor FROM bot_kontak LIMIT 50'); 
        let buttons = [];
        buttons.push([{ text: '🙋‍♂️ Saya Sendiri', callback_data: `assign_contact_self_${index}` }]);
        
        kontaks.forEach(k => {
            buttons.push([{ text: `👤 ${k.nama}`, callback_data: `assign_contact_${k.nomor}_${index}` }]);
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
        setState(chatId, { assignments: state.assignments });
        
        showAssignMenu(bot, chatId, state.parsedData);
        
    } else if (data === 'back_to_assign') {
        const state = getState(chatId);
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
        setState(chatId, { selectedQris: qrisId });
        finishSplitBill(bot, chatId);
    }

    bot.answerCallbackQuery(query.id);
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
        let qrisPath = '';
        if(qris && qris.length > 0) qrisPath = qris[0].file_path;
        
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
        if (qrisPath && fs.existsSync(qrisPath)) {
            qrisBase64 = fs.readFileSync(qrisPath).toString('base64');
            qrisFileName = path.basename(qrisPath);
            if (qrisFileName.endsWith('.png')) qrisMime = 'image/png';
        }
        
        // As per user specification, waGateway only has one bot running, we can just use the owner WA or anything for staff_id.
        // We'll use the environment OWNER_WA_NUMBER or just 'main' if not set, but actually the first connected client is safest, or we just insert and the queue processor takes it.
        // The queue processor queries by staff_id, let's use the first available staff_id from wa_incoming or assume 'main' is connected, or check connected clients.
        // Let's get the active staff_id from DB or just use a default one like process.env.OWNER_WA_NUMBER.
        let staffId = process.env.OWNER_WA_NUMBER || 'admin';
        // Better way: use the first connected client, but since telegram runs in the same process, we can't easily access `clients` array here unless exported.
        // Since we are writing to DB, let's look up the most recently active staff_id in wa_incoming or hardcode it to process.env.OWNER_WA_NUMBER.
        
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
