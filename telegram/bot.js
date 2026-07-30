let TelegramBot = require('node-telegram-bot-api');
if (typeof TelegramBot !== 'function') {
    TelegramBot = TelegramBot.default || TelegramBot.TelegramBot;
}
const { handleStart, handleMessage, handleCallbackQuery, handlePhoto } = require('./handlers');

function initTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.log('[Telegram] TELEGRAM_BOT_TOKEN tidak diset, bot tidak dijalankan.');
        return null;
    }

    const bot = new TelegramBot(token, { polling: true });
    
    bot.on('message', (msg) => {
        if (msg.photo) {
            handlePhoto(bot, msg);
        } else if (msg.text === '/start') {
            handleStart(bot, msg);
        } else if (msg.text) {
            handleMessage(bot, msg);
        }
    });

    bot.on('callback_query', (query) => {
        handleCallbackQuery(bot, query);
    });

    console.log('[Telegram] Bot sedang berjalan...');
    return bot;
}

module.exports = { initTelegramBot };
