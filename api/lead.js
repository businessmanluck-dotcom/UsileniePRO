// Приём заявок с форм сайта и отправка на почту info@usilenie.pro через SMTP Яндекс 360.
// Данные нигде не сохраняются — только пересылаются письмом.
//
// Переменные окружения (Vercel → Project → Settings → Environment Variables):
//   SMTP_USER  — ящик-отправитель, напр. info@usilenie.pro
//   SMTP_PASS  — пароль приложения Яндекс 360 (не основной пароль!)
//   LEAD_TO    — куда слать заявки (необязательно, по умолчанию = SMTP_USER)

const nodemailer = require('nodemailer');

const MAX_FIELDS = 20;
const MAX_LEN = 3000;
const SERVICE_FIELDS = ['_subject', '_hp', '_page', '_t'];

// Человекочитаемые подписи для имён полей форм
const LABELS = {
  'Согласие_ПДн': 'Согласие на обработку ПДн',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, max || MAX_LEN);
}

function oneLine(s, max) {
  return clean(s, max).replace(/[\r\n]+/g, ' ');
}

function label(key) {
  return LABELS[key] || key.replace(/_/g, ' ');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  // Антиспам: скрытое поле заполняют только боты; слишком быстрая отправка — тоже бот.
  // Боту отвечаем «успехом», чтобы он не пытался обойти защиту.
  const elapsed = Number(body._t);
  if (clean(body._hp) !== '' || (elapsed > 0 && elapsed < 3000)) {
    return res.status(200).json({ ok: true });
  }

  const fields = Object.keys(body)
    .filter((k) => !SERVICE_FIELDS.includes(k))
    .slice(0, MAX_FIELDS)
    .map((k) => [oneLine(k, 60), body[k] === 'on' ? 'да' : clean(body[k])])
    .filter(([, v]) => v !== '');

  const phone = fields.find(([k]) => /телефон/i.test(k));
  const consent = fields.find(([k]) => k === 'Согласие_ПДн');
  if (!phone || phone[1].replace(/\D/g, '').length < 10) {
    return res.status(422).json({ ok: false, error: 'phone_required' });
  }
  if (!consent) {
    return res.status(422).json({ ok: false, error: 'consent_required' });
  }

  const { SMTP_USER, SMTP_PASS, LEAD_TO } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('lead: SMTP_USER / SMTP_PASS not configured');
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  const subject = oneLine(body._subject, 150) || 'Заявка с сайта — Усиление ПРО';
  const page = oneLine(body._page, 300);
  const when = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
  const ip = oneLine(req.headers['x-forwarded-for'] || '', 100).split(',')[0];

  const rows = fields
    .map(([k, v]) => `<tr><td style="padding:6px 12px;border:1px solid #ddd;background:#f6f6f6;font-weight:600;vertical-align:top">${esc(label(k))}</td><td style="padding:6px 12px;border:1px solid #ddd;white-space:pre-wrap">${esc(v)}</td></tr>`)
    .join('');
  const meta = `<p style="color:#888;font-size:12px">Страница: ${esc(page || '—')}<br>Время (Оренбург): ${esc(when)}<br>IP: ${esc(ip || '—')}</p>`;
  const html = `<h2 style="font-family:Arial,sans-serif">${esc(subject)}</h2><table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">${rows}</table>${meta}`;
  const text = fields.map(([k, v]) => `${label(k)}: ${v}`).join('\n') + `\n\nСтраница: ${page || '—'}\nВремя: ${when}`;

  const email = fields.find(([k]) => /email/i.test(k));
  const replyTo = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email[1]) ? email[1] : undefined;

  const transporter = nodemailer.createTransport({
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.sendMail({
      from: `"Сайт usilenie.pro" <${SMTP_USER}>`,
      to: LEAD_TO || SMTP_USER,
      replyTo,
      subject: `${subject} — ${phone[1]}`,
      text,
      html,
    });
  } catch (e) {
    console.error('lead: sendMail failed', e && e.message);
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }

  return res.status(200).json({ ok: true });
};
