/** Shared by fetch.ts and ratelimit.ts so there is exactly one default sleep implementation. */
export const defaultSleep = (ms: number): Promise<void> => new Promise<void>(r => setTimeout(r, ms));
