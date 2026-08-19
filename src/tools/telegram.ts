const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface TelegramResult { sent: boolean; detail: string }

/**
 * Spec 15.3. An alert failure must never break the pipeline it reports on:
 * this never throws, regardless of why the send failed. The bot token is
 * only ever used to build the request URL — it is never logged or returned.
 */
export async function sendTelegram(text: string, deps: TelegramDeps = {}): Promise<TelegramResult> {
  const env = deps.env ?? process.env;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { sent: false, detail: 'telegram not configured' };

  const doFetch = deps.fetchImpl ?? fetch;
  const body = text.length > TELEGRAM_TEXT_LIMIT ? text.slice(0, TELEGRAM_TEXT_LIMIT) : text;

  // Defense in depth: err.message today never happens to embed the URL (and
  // therefore the token) for the errors Node's fetch throws, but that's an
  // artifact of fetch's error shape, not a guarantee — a network layer that
  // wraps "failed to parse URL <url>" would leak it straight into detail.
  // Scrub unconditionally rather than relying on that not happening.
  const redact = (detail: string): string => detail.split(token).join('<token>');

  try {
    const res = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      return { sent: false, detail: `Telegram API error: HTTP ${res.status}` };
    }
    return { sent: true, detail: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { sent: false, detail: redact(message.split('\n')[0]!) };
  }
}
