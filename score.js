// /api/score.js (Vercel Serverless - Node 18+)
import sgMail from '@sendgrid/mail';

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // CORS/Origin check
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin || req.headers.referer || '';
    if (allowed.length && !allowed.includes(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }

    const payload = req.body || {};
    const { answers, recaptchaToken, email } = payload;

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Missing answers' });
    }

    // If reCAPTCHA secret configured, verify token
    if (process.env.RECAPTCHA_SECRET) {
      if (!recaptchaToken) return res.status(400).json({ error: 'Missing recaptcha token' });

      // verify
      const params = new URLSearchParams();
      params.append('secret', process.env.RECAPTCHA_SECRET);
      params.append('response', recaptchaToken);

      const r = await fetch(RECAPTCHA_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const j = await r.json();
      // j: { success, score, action, challenge_ts, hostname, ... }
      const threshold = Number(process.env.RECAPTCHA_THRESHOLD || 0.4);
      if (!j.success || (typeof j.score === 'number' && j.score < threshold)) {
        return res.status(403).json({ error: 'Recaptcha verification failed', recaptcha: j });
      }
    }

    // Load private answer key from env
    if (!process.env.ANSWER_KEY_JSON) {
      return res.status(500).json({ error: 'Scoring not configured' });
    }
    const answerKey = JSON.parse(process.env.ANSWER_KEY_JSON); // map of id -> { goodAnswer, riskWeight, fix }

    // compute
    let score = 0;
    let maxPossible = 0;
    const breakdown = [];

    for (const qid of Object.keys(answerKey)) {
      const key = answerKey[qid];
      const w = Number(key.riskWeight || 1);
      const good = (key.goodAnswer || '').toString().trim();
      maxPossible += w * 2;

      const userAns = (answers[qid] || '').toString().trim();
      let points = 0;
      if (!userAns || userAns.toLowerCase() === 'not sure') {
        points = w;
      } else if (userAns === good) {
        points = 0;
      } else {
        points = w * 2;
      }
      breakdown.push({ id: qid, userAnswer: userAns || null, points, fix: key.fix || null });
      score += points;
    }

    const lowThresh = Number(process.env.LOW_THRESHOLD || Math.max(5, Math.floor(0.2 * maxPossible)));
    const medThresh = Number(process.env.MED_THRESHOLD || Math.max(10, Math.floor(0.5 * maxPossible)));
    let level = 'Low';
    if (score > medThresh) level = 'High';
    else if (score > lowThresh) level = 'Medium';

    const top = breakdown.sort((a,b)=>b.points-a.points).filter(x=>x.points>0).slice(0,5);

    const response = {
      score,
      maxPossible,
      level,
      topFixes: top,
      timestamp: new Date().toISOString()
    };

    // Optional: send email report if email present and SendGrid configured
    if (email && process.env.SENDGRID_API_KEY) {
      try {
        const html = `
          <h2>Your AI Safety Report</h2>
          <p>Score: <strong>${score}</strong> / ${maxPossible} — <strong>${level}</strong></p>
          <h3>Top Issues</h3>
          <ul>
            ${top.map(t => `<li>${t.fix || 'See details'} (points: ${t.points})</li>`).join('')}
          </ul>
          <p>Timestamp: ${response.timestamp}</p>
          <p>Note: This check is advisory, not a legal audit.</p>
        `;
        const msg = {
          to: email,
          from: process.env.SENDGRID_SENDER || 'no-reply@yourdomain.com', // verify this sender in SendGrid
          subject: 'Your AI Safety Report',
          html
        };
        await sgMail.send(msg);
        response.emailSent = true;
      } catch (sendErr) {
        console.error('SendGrid error', sendErr);
        response.emailSent = false;
        response.emailError = sendErr.message || String(sendErr);
      }
    }

    return res.status(200).json(response);

  } catch (err) {
    console.error('Scoring error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
