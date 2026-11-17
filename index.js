require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Telegraf } = require('telegraf');

// .env sozlamalari
const BOT_TOKEN = (process.env.BOT_TOKEN || '').replace(/['"]/g, '').trim();
const ADMIN_ID = Number((process.env.ADMIN_ID || '').replace(/['"]/g, '').trim());
const DEFAULT_CHANNEL = (process.env.CHANNEL_USERNAME || '').trim();
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN) {
  console.error('❌ XATO: .env faylida BOT_TOKEN topilmadi!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Inline menyuda chiqadigan chiroyli ikonka (Twemoji PNG)
const ICONS = {
  brain: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9e0.png',
  wait: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/23f3.png',
  duel: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2694.png',
  top: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3c6.png'
};

// ================= BAZA (db.json) =================
const DB_FILE = path.join(__dirname, 'db.json');
let db = {
  users: {},
  promos: {},
  settings: {
    adText: DEFAULT_CHANNEL ? `📢 Kanal: ${DEFAULT_CHANNEL}` : '',
    subChannel: '' // Majburiy obuna kanali (masalan: @kanal_nomi)
  },
  totalRolls: 0
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      db.users = raw.users || {};
      db.promos = raw.promos || {};
      db.settings = Object.assign(
        { adText: DEFAULT_CHANNEL ? `📢 Kanal: ${DEFAULT_CHANNEL}` : '', subChannel: '' },
        raw.settings || {}
      );
      db.totalRolls = Number(raw.totalRolls) || 0;
    }
  } catch (err) {
    console.error('⚠️ db.json o‘qishda xato:', err.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('⚠️ db.json saqlashda xato:', err.message);
  }
}

// ================= YORDAMCHI FUNKSIYALAR =================
const adminState = new Map();

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function getRank(iq) {
  if (iq <= 50) return '🪫 Quvvatsiz batareya';
  if (iq <= 85) return '😴 Uyquchi rejim';
  if (iq <= 120) return '🎒 Yosh tadqiqotchi';
  if (iq <= 170) return '🧠 Zakovat bilimdoni';
  if (iq <= 230) return '🎓 Professor';
  if (iq <= 320) return '⚡ Daho';
  return '🌌 Koinot intellekti';
}

function formatRemainingTime(ms) {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} soat ${minutes} daqiqa` : `${minutes} daqiqa`;
}

// +1..+9 (78% ehtimol) yoki -3..-4 (22% ehtimol)
function generateDelta() {
  if (Math.random() < 0.22) {
    return Math.random() < 0.5 ? -3 : -4;
  }
  return Math.floor(Math.random() * 9) + 1;
}

function getOrCreateUser(from, referrerId) {
  const id = String(from.id);
  if (!db.users[id]) {
    db.users[id] = {
      id: from.id,
      name: from.first_name || 'O‘yinchi',
      iq: 80,
      lastRoll: 0,
      lastBonus: 0,
      streak: 0,
      lastStreakDay: '',
      pendingDelta: null,
      referrals: 0,
      rollsCount: 0,
      joinedAt: Date.now()
    };

    if (referrerId && referrerId !== id && db.users[referrerId]) {
      db.users[referrerId].iq += 10;
      db.users[referrerId].referrals = (db.users[referrerId].referrals || 0) + 1;
      bot.telegram.sendMessage(
        referrerId,
        `🎉 Sizning referal havolangiz orqali <b>${escapeHTML(from.first_name)}</b> qo‘shildi!\n🎁 Bonus: <b>+10 IQ</b> (Jami: <b>${db.users[referrerId].iq} IQ</b>)`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    saveDB();
  } else if (from.first_name && db.users[id].name !== from.first_name) {
    db.users[id].name = from.first_name;
    saveDB();
  }
  return db.users[id];
}

function getUserPlace(userId) {
  const sorted = Object.values(db.users).sort((a, b) => b.iq - a.iq);
  const index = sorted.findIndex((u) => String(u.id) === String(userId));
  return index !== -1 ? index + 1 : sorted.length;
}

// Majburiy obunani tekshirish
async function checkSubscription(userId) {
  const ch = (db.settings.subChannel || '').trim();
  if (!ch || userId === ADMIN_ID) return true;
  try {
    const member = await bot.telegram.getChatMember(ch, userId);
    return ['creator', 'administrator', 'member'].indexOf(member.status) !== -1;
  } catch (err) {
    // Agar bot kanalda admin bo'lmasa xato bermasligi uchun o'tkazib yuboradi
    return true;
  }
}

async function requireSub(ctx) {
  const isSub = await checkSubscription(ctx.from.id);
  if (isSub) return true;

  const ch = db.settings.subChannel.replace('@', '');
  await ctx.reply(
    `🛑 <b>Botdan to‘liq foydalanish uchun rasmiy kanalimizga obuna bo‘ling!</b>\n\nObuna bo‘lgach, «✅ Tekshirish» tugmasini bosing:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Kanalga obuna bo‘lish', url: `https://t.me/${ch}` }],
          [{ text: '✅ Tekshirish', callback_data: 'check_sub' }]
        ]
      }
    }
  );
  return false;
}

// ================= JONLI LOG =================
bot.use((ctx, next) => {
  const uid = ctx.from ? ctx.from.id : 'unknown';
  const text = ctx.message && ctx.message.text ? ` (${ctx.message.text})` : '';
  console.log(`[LOG] ${ctx.updateType} | ID: ${uid}${text}`);
  return next();
});

// ================= ASOSIY MENYU TUGMALARI =================
function getMainMenuKeyboard(botUsername) {
  return {
    inline_keyboard: [
      [{ text: '🚀 Guruhda IQ yig‘ish', switch_inline_query: '' }],
      [{ text: '🧠 Shu yerda charxlash', switch_inline_query_current_chat: '' }],
      [
        { text: '👤 Mening profilim', callback_data: 'my_profile' },
        { text: '🎁 Kunlik bonus', callback_data: 'daily_bonus' }
      ],
      [{ text: '🏆 TOP-10 Reyting', callback_data: 'show_top' }]
    ]
  };
}

// ================= /START BUYRUG'I =================
bot.start(async (ctx) => {
  try {
    const parts = (ctx.message.text || '').split(' ');
    const refPayload = parts.length > 1 ? parts[1].trim() : '';
    const userData = getOrCreateUser(ctx.from, refPayload);
    const botUsername = ctx.botInfo ? ctx.botInfo.username : 'miyyagrambot';
    const refLink = `https://t.me/${botUsername}?start=${userData.id}`;

    await ctx.reply(
      `🧠 <b>Miyagram — Intellektual o‘yin botiga xush kelibsiz!</b>\n\n` +
      `🎓 Sizning balingiz: <b>${userData.iq} IQ</b>\n` +
      `🏅 Unvoningiz: <b>${getRank(userData.iq)}</b>\n` +
      `🏆 Umumiy reytingdagi o‘rningiz: <b>#${getUserPlace(userData.id)}</b>\n\n` +
      `📌 <b>Qanday o‘ynaladi?</b>\n` +
      `• Har <b>8 soatda</b> chatda <code>@${botUsername}</code> deb yozib <b>+1 dan +9 gacha IQ</b> yig‘ing (ba'zan <b>-3/-4 IQ</b> tushishi mumkin).\n` +
      `• Do‘st bilan jang qilish uchun: <code>@${botUsername} Ism</code>\n` +
      `• Promokod ishlatish: <code>/promo KOD</code>\n` +
      `• Har bir taklif qilingan do‘st uchun <b>+10 IQ</b> olasiz!\n\n` +
      `🔗 <b>Sizning referal havolangiz:</b>\n<code>${refLink}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(botUsername)
      }
    );
  } catch (err) {
    console.error('Start xatosi:', err);
  }
});

// ================= PROFIL, BONUS, PROMO VA GURUH KOMANDALARI =================
bot.action('check_sub', async (ctx) => {
  const isSub = await checkSubscription(ctx.from.id);
  if (!isSub) {
    return ctx.answerCbQuery('❌ Hali kanalga obuna bo‘lmadingiz!', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Obuna tasdiqlandi!');
  await ctx.deleteMessage().catch(() => {});
  const botUsername = ctx.botInfo ? ctx.botInfo.username : 'miyyagrambot';
  await ctx.reply('✅ <b>Rahmat! Endi barcha bo‘limlardan foydalanishingiz mumkin:</b>', {
    parse_mode: 'HTML',
    reply_markup: getMainMenuKeyboard(botUsername)
  });
});

async function sendProfile(ctx, isCallback) {
  if (!(await requireSub(ctx))) return;
  const u = getOrCreateUser(ctx.from);
  const botUsername = ctx.botInfo ? ctx.botInfo.username : 'miyyagrambot';
  const refLink = `https://t.me/${botUsername}?start=${u.id}`;

  const text =
    `👤 <b>O‘yinchi profili: ${escapeHTML(u.name)}</b>\n\n` +
    `🆔 ID: <code>${u.id}</code>\n` +
    `🧠 IQ darajasi: <b>${u.iq} IQ</b>\n` +
    `🏅 Unvon: <b>${getRank(u.iq)}</b>\n` +
    `🏆 Reytingdagi o‘rni: <b>#${getUserPlace(u.id)}</b>\n` +
    `🔥 Kunlik seriya (Streak): <b>${u.streak || 0} kun</b>\n` +
    `🎲 Jami urinishlar: <b>${u.rollsCount || 0} marta</b>\n` +
    `👥 Taklif qilgan do‘stlari: <b>${u.referrals || 0} ta</b>\n\n` +
    `🔗 <b>Referal havola (+10 IQ):</b>\n<code>${refLink}</code>`;

  if (isCallback) {
    await ctx.answerCbQuery();
    return ctx.reply(text, { parse_mode: 'HTML' });
  }
  return ctx.reply(text, { parse_mode: 'HTML' });
}

bot.command(['profile', 'myiq'], (ctx) => sendProfile(ctx, false));
bot.action('my_profile', (ctx) => sendProfile(ctx, true));

async function handleDailyBonus(ctx, isCallback) {
  if (!(await requireSub(ctx))) return;
  const u = getOrCreateUser(ctx.from);
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const diff = now - (u.lastBonus || 0);

  if (diff < oneDay) {
    const wait = formatRemainingTime(oneDay - diff);
    if (isCallback) {
      return ctx.answerCbQuery(`⏳ Kunlik bonusni ${wait} dan keyin olishingiz mumkin!`, { show_alert: true });
    }
    return ctx.reply(`⏳ Kunlik bonusni <b>${wait}</b> dan keyin olishingiz mumkin!`, { parse_mode: 'HTML' });
  }

  const bonus = Math.floor(Math.random() * 5) + 1; // +1..+5 IQ
  u.iq += bonus;
  u.lastBonus = now;
  saveDB();

  if (isCallback) await ctx.answerCbQuery(`🎁 Tabriklaymiz! +${bonus} IQ oldingiz!`, { show_alert: true });
  return ctx.reply(
    `🎁 <b>Kunlik bonus olindi!</b>\n\n📈 Sizga <b>+${bonus} IQ</b> taqdim etildi.\n🎓 Jami balingiz: <b>${u.iq} IQ</b>`,
    { parse_mode: 'HTML' }
  );
}

bot.command('bonus', (ctx) => handleDailyBonus(ctx, false));
bot.action('daily_bonus', (ctx) => handleDailyBonus(ctx, true));

// TOP-10 buyrug'i (Guruhda va bot ichida)
async function sendTopList(ctx, isCallback) {
  if (isCallback) await ctx.answerCbQuery();
  const topUsers = Object.values(db.users).sort((a, b) => b.iq - a.iq).slice(0, 10);
  let text = '🏆 <b>MIYAGRAM — ENG AQLLILAR TOP-10:</b>\n\n';
  for (let i = 0; i < topUsers.length; i++) {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    text += `${medal} <b>${escapeHTML(topUsers[i].name)}</b> — <b>${topUsers[i].iq} IQ</b> <i>(${getRank(topUsers[i].iq)})</i>\n`;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
}

bot.command('top', (ctx) => sendTopList(ctx, false));
bot.action('show_top', (ctx) => sendTopList(ctx, true));

// Promokod ishlatish (/promo KOD)
bot.command('promo', async (ctx) => {
  if (!(await requireSub(ctx))) return;
  const parts = (ctx.message.text || '').split(' ');
  const code = parts[1] ? parts[1].trim().toUpperCase() : '';

  if (!code) {
    return ctx.reply('🎟 Foydalanish: <code>/promo KOD</code>', { parse_mode: 'HTML' });
  }

  const promo = db.promos[code];
  if (!promo) {
    return ctx.reply('❌ Bunday promokod mavjud emas yoki muddati tugagan!');
  }
  if (promo.usedBy.indexOf(ctx.from.id) !== -1) {
    return ctx.reply('⚠️ Siz bu promokoddan allaqachon foydalangansiz!');
  }
  if (promo.usedBy.length >= promo.maxUses) {
    return ctx.reply('😔 Afsuski, bu promokodning limiti tugab bo‘ldi!');
  }

  const u = getOrCreateUser(ctx.from);
  u.iq += promo.iq;
  promo.usedBy.push(ctx.from.id);
  saveDB();

  await ctx.reply(
    `🎉 <b>Promokod muvaffaqiyatli faollashtirildi!</b>\n\n` +
    `🎁 Qo‘shildi: <b>+${promo.iq} IQ</b>\n` +
    `🎓 Jami balingiz: <b>${u.iq} IQ</b>`,
    { parse_mode: 'HTML' }
  );
});

// ================= TUGMALI ADMIN PANEL (/admin) =================
function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Statistika', callback_data: 'adm_stat' },
        { text: '📢 Xabar tarqatish', callback_data: 'adm_broadcast' }
      ],
      [
        { text: '🎟 Promokod yaratish', callback_data: 'adm_promo' },
        { text: '🎯 IQ berish / ayirish', callback_data: 'adm_give_iq' }
      ],
      [
        { text: '🔗 Reklama matni', callback_data: 'adm_ad' },
        { text: '🔐 Majburiy obuna', callback_data: 'adm_sub' }
      ],
      [
        { text: '⚡ Vaqtimni ochish', callback_data: 'adm_reset_me' },
        { text: '💾 Bazani yuklab olish', callback_data: 'adm_backup' }
      ]
    ]
  };
}

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply(
      `⛔ Siz admin emassiz!\nSizning Telegram ID raqamingiz: <code>${ctx.from.id}</code>`,
      { parse_mode: 'HTML' }
    );
  }
  adminState.delete(ctx.from.id);
  await ctx.reply('🛠 <b>Miyagram PRO Admin Paneli</b>\n\nKerakli amalni tanlang:', {
    parse_mode: 'HTML',
    reply_markup: getAdminKeyboard()
  });
});

bot.command('cancel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  adminState.delete(ctx.from.id);
  await ctx.reply('❌ Amal bekor qilindi.');
});

bot.action('adm_stat', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();

  const usersList = Object.values(db.users);
  const now = Date.now();
  const active24h = usersList.filter((u) => now - u.lastRoll < 24 * 60 * 60 * 1000).length;
  const sorted = usersList.slice().sort((a, b) => b.iq - a.iq);
  const topUser = sorted[0];
  const promoCount = Object.keys(db.promos).length;

  await ctx.editMessageText(
    `📊 <b>Miyagram Statistikasi:</b>\n\n` +
    `👤 Jami o‘yinchilar: <b>${usersList.length} ta</b>\n` +
    `🔥 24 soatda faollar: <b>${active24h} ta</b>\n` +
    `🎲 Jami inline charxlashlar: <b>${db.totalRolls} marta</b>\n` +
    `🎟 Faol promokodlar: <b>${promoCount} ta</b>\n` +
    `👑 Lider: <b>${topUser ? escapeHTML(topUser.name) + ' (' + topUser.iq + ' IQ)' : 'Yo‘q'}</b>\n` +
    `🔐 Majburiy obuna: <code>${escapeHTML(db.settings.subChannel || 'O‘chiq')}</code>\n` +
    `📢 Reklama: <code>${escapeHTML(db.settings.adText || 'Yo‘q')}</code>\n` +
    `🕒 Yangilandi: <code>${new Date().toLocaleTimeString()}</code>`,
    { parse_mode: 'HTML', reply_markup: getAdminKeyboard() }
  ).catch(() => {});
});

bot.action('adm_reset_me', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const userData = getOrCreateUser(ctx.from);
  userData.lastRoll = 0;
  userData.pendingDelta = null;
  saveDB();
  await ctx.answerCbQuery('✅ 8 soatlik cheklovingiz olib tashlandi!', { show_alert: true });
});

bot.action('adm_backup', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery('⏳ Baza yuborilmoqda...');
  saveDB();
  await ctx.replyWithDocument(
    { source: DB_FILE, filename: `miyagram_backup_${Date.now()}.json` },
    { caption: `💾 <b>Miyagram baza nusxasi</b>\n👤 O‘yinchilar: ${Object.keys(db.users).length} ta`, parse_mode: 'HTML' }
  );
});

bot.action('adm_promo', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, 'WAITING_PROMO');
  await ctx.reply(
    `🎟 <b>Yangi promokod yaratish</b>\n\n` +
    `Quyidagi formatda yozib yuboring:\n<code>KOD IQ_MIQDORI LIMIT</code>\n\n` +
    `Misol: <code>ZAKOVAT 15 50</code>\n<i>(ZAKOVAT kodi 50 ta odamga +15 IQ beradi)</i>\nBekor qilish: /cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.action('adm_give_iq', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, 'WAITING_GIVE_IQ');
  await ctx.reply(
    `🎯 <b>Foydalanuvchiga IQ qo‘shish yoki ayirish</b>\n\n` +
    `Quyidagi formatda yozing:\n<code>USER_ID MIQDOR</code>\n\n` +
    `Misol: <code>${ADMIN_ID} 50</code> yoki <code>${ADMIN_ID} -20</code>\nBekor qilish: /cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.action('adm_ad', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, 'WAITING_AD');
  await ctx.reply(
    `🔗 <b>Natija tagida chiqadigan reklama matnini yuboring:</b>\n\n` +
    `Misol: <code>📢 Kanalimiz: @kanal_nomi</code>\nO‘chirish uchun <code>off</code> deb yozing. Bekor qilish: /cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.action('adm_sub', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, 'WAITING_SUB');
  await ctx.reply(
    `🔐 <b>Majburiy obuna kanalini kiriting:</b>\n\n` +
    `Misol: <code>@kanal_username</code> (Bot o‘sha kanalda admin bo‘lishi kerak).\n` +
    `O‘chirish uchun <code>off</code> deb yozing. Bekor qilish: /cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.action('adm_broadcast', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.answerCbQuery();
  adminState.set(ctx.from.id, 'WAITING_BROADCAST');
  await ctx.reply(
    `📢 <b>Barcha o‘yinchilarga yuboriladigan xabarni tashlang:</b>\n\n` +
    `<i>Oddiy matn, rasm, video yoki tayyor post yuborishingiz mumkin.</i>\nBekor qilish: /cancel`,
    { parse_mode: 'HTML' }
  );
});

// ================= INLINE REJIM (@miyyagrambot) =================
bot.on('inline_query', async (ctx) => {
  try {
    const userData = getOrCreateUser(ctx.from);
    const botUsername = ctx.botInfo ? ctx.botInfo.username : 'miyyagrambot';
    const rawQuery = (ctx.inlineQuery.query || '').trim();
    const now = Date.now();
    const cooldown = 8 * 60 * 60 * 1000; // 8 soat
    const timePassed = now - userData.lastRoll;

    const adLine = db.settings.adText ? `\n${db.settings.adText}` : '';
    const footer = `\n\n👉 @${botUsername}${adLine}`;

    const replyMarkup = {
      inline_keyboard: [
        [{ text: '🧠 Miyani charxlash (+IQ)', switch_inline_query_current_chat: '' }],
        [{ text: '🎁 Botga kirish (+Bonus)', url: `https://t.me/${botUsername}?start=${userData.id}` }]
      ]
    };

    const results = [];
    const safeName = escapeHTML(userData.name);

    // 1. Asosiy IQ charxlash (8 soatda 1 marta)
    if (timePassed >= cooldown) {
      if (userData.pendingDelta === null || userData.pendingDelta === undefined) {
        userData.pendingDelta = generateDelta();
        saveDB();
      }

      const delta = userData.pendingDelta;
      const newIq = Math.max(0, userData.iq + delta);
      const rank = getRank(newIq);

      const messageText = delta > 0
        ? `🧠 <b>${safeName}</b> miyasini charxladi!\n\n` +
          `📈 Natija: <b>+${delta} IQ</b> qo‘shildi!\n` +
          `🎓 Jami IQ: <b>${newIq}</b> (${rank})\n` +
          `🏆 Reytingdagi o‘rni: <b>#${getUserPlace(userData.id)}</b>\n\n` +
          `⏳ Keyingi urinish: <b>8 soatdan keyin</b>` + footer
        : `😵‍💫 <b>${safeName}</b> miyasini haddan tashqari zo‘riqtirib yubordi!\n\n` +
          `📉 Natija: <b>${delta} IQ</b> kamaydi!\n` +
          `🎓 Jami IQ: <b>${newIq}</b> (${rank})\n` +
          `🏆 Reytingdagi o‘rni: <b>#${getUserPlace(userData.id)}</b>\n\n` +
          `⏳ Keyingi urinish: <b>8 soatdan keyin</b>` + footer;

      results.push({
        type: 'article',
        id: 'roll_' + userData.id + '_' + now,
        title: `🧠 Miyani charxlash (Tayyor!)`,
        description: `Hozirgi IQ: ${userData.iq} | Bosing va yangi IQ oling!`,
        thumb_url: ICONS.brain,
        input_message_content: { message_text: messageText, parse_mode: 'HTML' },
        reply_markup: replyMarkup
      });
    } else {
      const leftText = formatRemainingTime(cooldown - timePassed);
      results.push({
        type: 'article',
        id: 'wait_' + userData.id + '_' + now,
        title: `⏳ Kutish rejimi (${userData.iq} IQ)`,
        description: `Keyingi urinishgacha ${leftText} qoldi`,
        thumb_url: ICONS.wait,
        input_message_content: {
          message_text:
            `🧠 <b>${safeName}</b>ning hozirgi ko‘rsatkichi:\n\n` +
            `🎓 IQ darajasi: <b>${userData.iq} IQ</b>\n` +
            `🏅 Unvon: <b>${getRank(userData.iq)}</b>\n` +
            `🏆 Reytingdagi o‘rni: <b>#${getUserPlace(userData.id)}</b>\n\n` +
            `⏳ Yana IQ yig‘ish uchun <b>${leftText}</b> kutish kerak!` + footer,
          parse_mode: 'HTML'
        },
        reply_markup: replyMarkup
      });
    }

    // 2. Do'st bilan solishtirish (@miyyagrambot Ism)
    if (rawQuery.length > 0) {
      const oppName = escapeHTML(rawQuery);
      // Agar bazada shu ismli odam bo'lsa haqiqiy IQ'sini oladi, bo'lmasa tasodifiy
      const foundOpp = Object.values(db.users).find(
        (u) => u.name.toLowerCase() === rawQuery.replace('@', '').toLowerCase()
      );
      const oppIq = foundOpp ? foundOpp.iq : Math.floor(Math.random() * 130) + 55;
      const myIq = userData.iq;

      let winText = '🤝 Kuchlar teng keldi!';
      if (myIq > oppIq) winText = `🏆 G‘olib: <b>${safeName}</b> (+${myIq - oppIq} IQ ustunlik!)`;
      if (oppIq > myIq) winText = `🏆 G‘olib: <b>${oppName}</b> (+${oppIq - myIq} IQ ustunlik!)`;

      results.push({
        type: 'article',
        id: 'duel_' + now,
        title: `⚔️ Miya jangi: ${userData.name} vs ${rawQuery}`,
        description: 'Kimning IQ darajasi yuqoriligini guruhda tekshirish!',
        thumb_url: ICONS.duel,
        input_message_content: {
          message_text:
            `⚔️ <b>INTELLEKTUAL DUEL</b>\n\n` +
            `👤 <b>${safeName}:</b> ${myIq} IQ <i>(${getRank(myIq)})</i>\n` +
            `👤 <b>${oppName}:</b> ${oppIq} IQ <i>(${getRank(oppIq)})</i>\n\n` +
            `${winText}` + footer,
          parse_mode: 'HTML'
        },
        reply_markup: replyMarkup
      });
    }

    // 3. TOP-10 Reyting
    const topUsers = Object.values(db.users).sort((a, b) => b.iq - a.iq).slice(0, 10);
    let topText = '🏆 <b>MIYAGRAM — ENG AQLLILAR TOP-10:</b>\n\n';
    for (let i = 0; i < topUsers.length; i++) {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      topText += `${medal} <b>${escapeHTML(topUsers[i].name)}</b> — <b>${topUsers[i].iq} IQ</b>\n`;
    }
    topText += footer;

    results.push({
      type: 'article',
      id: 'top_' + now,
      title: '🏆 Eng aqllilar reytingi (TOP-10)',
      description: 'Eng yuqori IQ egalarini chatga yuborish',
      thumb_url: ICONS.top,
      input_message_content: { message_text: topText, parse_mode: 'HTML' },
      reply_markup: replyMarkup
    });

    await ctx.answerInlineQuery(results, { cache_time: 1, is_personal: true });
  } catch (err) {
    console.error('Inline query xatosi:', err);
  }
});

// Inline natija chatga yuborilganda ballni va Streak'ni hisoblash
bot.on('chosen_inline_result', (ctx) => {
  try {
    const resultId = (ctx.chosenInlineResult && ctx.chosenInlineResult.result_id) || '';
    if (resultId.indexOf('roll_') === 0) {
      const userData = getOrCreateUser(ctx.from);
      if (userData.pendingDelta !== null && userData.pendingDelta !== undefined) {
        userData.iq = Math.max(0, userData.iq + userData.pendingDelta);
        userData.lastRoll = Date.now();
        userData.rollsCount = (userData.rollsCount || 0) + 1;
        userData.pendingDelta = null;

        // Kunlik Streak (seriya) hisoblash
        const todayStr = new Date().toISOString().slice(0, 10);
        if (userData.lastStreakDay !== todayStr) {
          userData.lastStreakDay = todayStr;
          userData.streak = (userData.streak || 0) + 1;
          // Har 3 kunlik seriyada +5 IQ bonus
          if (userData.streak % 3 === 0) {
            userData.iq += 5;
            bot.telegram.sendMessage(
              userData.id,
              `🔥 <b>${userData.streak} kunlik faollik seriyasi!</b>\n🎁 Sizga qo‘shimcha <b>+5 IQ</b> bonus berildi!`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        }

        db.totalRolls += 1;
        saveDB();
      }
    }
  } catch (err) {
    console.error('Chosen inline xatosi:', err);
  }
});

// ================= ADMIN KIRITMALARI (MATN VA MEDIA BROADCAST) =================
bot.on(['text', 'photo', 'video', 'animation', 'document'], async (ctx, next) => {
  // Agar komanda bo'lsa o'tkazib yuboramiz
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
    return next();
  }
  if (!ctx.from || ctx.from.id !== ADMIN_ID || !adminState.has(ctx.from.id)) {
    return next();
  }

  const state = adminState.get(ctx.from.id);
  adminState.delete(ctx.from.id);
  const text = (ctx.message.text || '').trim();

  if (state === 'WAITING_AD') {
    db.settings.adText = text.toLowerCase() === 'off' ? '' : text;
    saveDB();
    return ctx.reply(db.settings.adText ? `✅ Reklama saqlandi:\n\n${text}` : '✅ Reklama o‘chirildi.');
  }

  if (state === 'WAITING_SUB') {
    db.settings.subChannel = text.toLowerCase() === 'off' ? '' : text;
    saveDB();
    return ctx.reply(
      db.settings.subChannel
        ? `✅ Majburiy obuna kanali o‘rnatildi: ${text}`
        : '✅ Majburiy obuna o‘chirildi.'
    );
  }

  if (state === 'WAITING_PROMO') {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      return ctx.reply('❌ Xato format! Misol: <code>ZAKOVAT 15 50</code>', { parse_mode: 'HTML' });
    }
    const code = parts[0].toUpperCase();
    const iqVal = Number(parts[1]);
    const maxUses = Number(parts[2]);

    if (!iqVal || !maxUses) {
      return ctx.reply('❌ IQ va Limit son bo‘lishi kerak!');
    }

    db.promos[code] = { iq: iqVal, maxUses: maxUses, usedBy: [] };
    saveDB();

    return ctx.reply(
      `✅ <b>Promokod yaratildi!</b>\n\n` +
      `🎟 Kod: <code>/promo ${code}</code>\n` +
      `🎁 Qiymati: <b>+${iqVal} IQ</b>\n` +
      `👥 Limit: <b>${maxUses} ta foydalanuvchi</b>`,
      { parse_mode: 'HTML' }
    );
  }

  if (state === 'WAITING_GIVE_IQ') {
    const parts = text.split(/\s+/);
    const targetId = parts[0];
    const amount = Number(parts[1]);

    if (!targetId || isNaN(amount) || !db.users[targetId]) {
      return ctx.reply('❌ Foydalanuvchi topilmadi yoki miqdor xato kiritildi!');
    }

    db.users[targetId].iq = Math.max(0, db.users[targetId].iq + amount);
    saveDB();

    return ctx.reply(
      `✅ <b>${escapeHTML(db.users[targetId].name)}</b> balansi o‘zgartirildi!\n` +
      `🎓 Yangi balans: <b>${db.users[targetId].iq} IQ</b>`,
      { parse_mode: 'HTML' }
    );
  }

  if (state === 'WAITING_BROADCAST') {
    const userIds = Object.keys(db.users);
    let sent = 0;
    let failed = 0;

    await ctx.reply(`⏳ ${userIds.length} ta o‘yinchiga xabar yuborilmoqda...`);

    for (let i = 0; i < userIds.length; i++) {
      try {
        await bot.telegram.copyMessage(userIds[i], ctx.chat.id, ctx.message.message_id);
        sent++;
      } catch (err) {
        failed++;
      }
    }

    return ctx.reply(
      `✅ <b>Xabar tarqatish yakunlandi!</b>\n\n📨 Yetib bordi: <b>${sent}</b>\n❌ Bloklaganlar: <b>${failed}</b>`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.catch((err) => {
  console.error('⚠️ Bot xatosi:', err);
});

// ================= SERVER VA ISHGA TUSHIRISH =================
app.get('/', (req, res) => {
  res.send('Miyagram PRO bot 100% ishlamoqda!');
});

app.listen(PORT, () => {
  console.log(`🌐 Web-server ${PORT}-portda ishga tushdi`);
});

async function startBot() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    const me = await bot.telegram.getMe();
    bot.botInfo = me;
    console.log(`✅ @${me.username} PRO versiyada ishga tushdi! Admin ID: ${ADMIN_ID}`);
    await bot.launch();
  } catch (err) {
    console.error('❌ Ulanishda xato:', err.message);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));