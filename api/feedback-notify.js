// Vercel serverless function — per-submission feedback notifier
//
// POST /api/feedback-notify
// Header: Authorization: Bearer <FEEDBACK_WEBHOOK_SECRET>
// Body: Supabase Database Webhook payload —
//   { type: 'INSERT', table: 'vinyl_feedback', record: {...} }
//
// Flow: verify shared secret -> parse record -> Resend email to Todd.
// Returns 5xx on Resend failure so Supabase webhook retries.
//
// Reachable at: https://elbrinks-crate.vercel.app/api/feedback-notify
// Hub rewrite:  https://elbrink.com/vinyl/api/feedback-notify

import { Resend } from 'resend';

export const config = { runtime: 'nodejs' };

const NOTIFY_TO = 'toddelbrink@gmail.com';
const NOTIFY_FROM = 'Crate Feedback <onboarding@resend.dev>';
const ADMIN_URL = 'https://elbrink.com/vinyl/admin/feedback';

function formatCT(iso) {
  if (!iso) return '(unknown)';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' CT';
  } catch {
    return iso;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1. Shared-secret auth
  const expected = process.env.FEEDBACK_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[feedback-notify] FEEDBACK_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // 2. Parse webhook payload
  const body = req.body || {};
  if (body.type !== 'INSERT' || body.table !== 'vinyl_feedback') {
    res.status(200).json({ skipped: 'not a feedback insert' });
    return;
  }
  const record = body.record || {};
  const {
    id,
    user_id,
    sentiment,
    category,
    body: feedbackBody,
    app_version,
    created_at,
  } = record;

  // 3. Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[feedback-notify] RESEND_API_KEY not configured');
    res.status(500).json({ error: 'Resend not configured' });
    return;
  }
  const resend = new Resend(apiKey);

  const sentimentLabel = sentiment ? sentiment.toUpperCase() : '—';
  const categoryLabel = category || '—';
  const preview = (feedbackBody || '').trim().slice(0, 60).replace(/\s+/g, ' ');
  const subject = preview
    ? `[Crate] ${categoryLabel} (${sentimentLabel}) — ${preview}${feedbackBody && feedbackBody.length > 60 ? '...' : ''}`
    : `[Crate] ${categoryLabel} (${sentimentLabel}) — no body`;

  const text =
    `NEW CRATE FEEDBACK\n` +
    `------------------\n` +
    `Sentiment:   ${sentimentLabel}\n` +
    `Category:    ${categoryLabel}\n` +
    `\n` +
    `Body:\n${feedbackBody || '(no body provided)'}\n` +
    `\n` +
    `------------------\n` +
    `App version: ${app_version || '(unknown)'}\n` +
    `User ID:     ${user_id || '(unknown)'}\n` +
    `Feedback ID: ${id || '(unknown)'}\n` +
    `Submitted:   ${formatCT(created_at)}\n` +
    `\n` +
    `Admin: ${ADMIN_URL}\n`;

  try {
    const { data, error } = await resend.emails.send({
      from: NOTIFY_FROM,
      to: NOTIFY_TO,
      subject,
      text,
    });
    if (error) {
      console.error('[feedback-notify] Resend error', error);
      res.status(502).json({ error: 'Resend send failed', detail: error.message || error });
      return;
    }
    res.status(200).json({ ok: true, email_id: data?.id || null });
  } catch (e) {
    console.error('[feedback-notify] Resend threw', e?.message || e);
    res.status(502).json({ error: 'Resend threw: ' + (e?.message || 'unknown') });
  }
}
