import { describe, expect, it, vi } from 'vitest';
import { sendTelegram } from '../src/tools/telegram.js';

const ENV = { TELEGRAM_BOT_TOKEN: 'secret-token-123', TELEGRAM_CHAT_ID: '42' } as NodeJS.ProcessEnv;

function okFetch() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

describe('sendTelegram', () => {
  it('posts to the bot token URL with the expected JSON body', async () => {
    const fetchImpl = okFetch();
    const result = await sendTelegram('hello world', { env: ENV, fetchImpl });

    expect(result.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botsecret-token-123/sendMessage');
    expect(init!.method).toBe('POST');
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ chat_id: '42', text: 'hello world', disable_web_page_preview: true });
  });

  it('makes no network call and reports unconfigured when the token is unset', async () => {
    const fetchImpl = okFetch();
    const result = await sendTelegram('hi', {
      env: { TELEGRAM_CHAT_ID: '42' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toEqual({ sent: false, detail: 'telegram not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no network call and reports unconfigured when the chat id is unset', async () => {
    const fetchImpl = okFetch();
    const result = await sendTelegram('hi', {
      env: { TELEGRAM_BOT_TOKEN: 'secret-token-123' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toEqual({ sent: false, detail: 'telegram not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a blank (whitespace-only) token/chat id as unset', async () => {
    const fetchImpl = okFetch();
    const result = await sendTelegram('hi', {
      env: { TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '42' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when fetch itself throws', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });
    const result = await sendTelegram('hi', { env: ENV, fetchImpl });

    expect(result).toEqual({ sent: false, detail: 'ECONNREFUSED' });
  });

  // Fix round 1, finding 2: the token-scrubbing used to be accidental — it
  // relied on fetch's real error messages never happening to embed the
  // request URL. This pins the defensive redact() call directly: an error
  // shape that DOES embed the token (e.g. a URL-parse failure) must still
  // come back scrubbed.
  it('redacts the token from an error message that embeds the request URL', async () => {
    const token = ENV.TELEGRAM_BOT_TOKEN as string;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`Failed to parse URL from https://api.telegram.org/bot${token}/sendMessage`);
    });
    const result = await sendTelegram('hi', { env: ENV, fetchImpl });

    expect(result.sent).toBe(false);
    expect(result.detail).toContain('<token>');
    expect(result.detail).not.toContain(token);
  });

  it('never throws on an HTTP error response and reports the status, not the token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Unauthorized', { status: 401 }));
    const result = await sendTelegram('hi', { env: ENV, fetchImpl });

    expect(result.sent).toBe(false);
    expect(result.detail).toContain('401');
    expect(result.detail).not.toContain(ENV.TELEGRAM_BOT_TOKEN as string);
  });

  it('reports only the first line of a multi-line error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('boom\nwith a stack trace'); });
    const result = await sendTelegram('hi', { env: ENV, fetchImpl });

    expect(result.detail).toBe('boom');
  });

  it('truncates text to 4096 chars before sending', async () => {
    const fetchImpl = okFetch();
    const longText = 'x'.repeat(5000);
    await sendTelegram(longText, { env: ENV, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect((body.text as string).length).toBe(4096);
  });

  it('leaves text at or under 4096 chars untouched', async () => {
    const fetchImpl = okFetch();
    const text = 'y'.repeat(4096);
    await sendTelegram(text, { env: ENV, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect((body.text as string).length).toBe(4096);
    expect(body.text).toBe(text);
  });
});
