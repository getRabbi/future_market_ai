import { HttpClient } from '@futuregrow/connectors';
import { expect, it, vi } from 'vitest';
import { braveSearchProvider, rankWebCandidate } from '../src/modules/m05-competitors/search-providers.js';

it('uses documented Brave requests, bounded retries and review-only index evidence', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '4' } }))
    .mockResolvedValueOnce(Response.json({ web: { results: [{ title: 'Korean Lessons', url: 'https://play.google.com/store/apps/details?id=com.example.korean&hl=en', description: 'Practice Korean lessons' }] } }));
  const sleep = vi.fn(async () => {});
  const provider = braveSearchProvider(new HttpClient({ fetchImpl, maxRetries: 0 }), 'fixture-key', true, sleep);
  const results = await provider.search('Korean Lessons', 'BD');
  expect(sleep).toHaveBeenCalledWith(4000);
  expect(fetchImpl.mock.calls[0]![0]).toContain('https://api.search.brave.com/res/v1/web/search?');
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', headers: { 'X-Subscription-Token': 'fixture-key' } });
  expect(provider.rank!('Korean Lessons', results[0], new Date())).toMatchObject({ identity: 'google_play:com.example.korean', confidence: 0.5, url: 'https://play.google.com/store/apps/details?id=com.example.korean' });
  expect(rankWebCandidate('Korean', { title: 'Korean', url: 'https://127.0.0.1/', description: '' }, false)).toBeNull();
  expect(rankWebCandidate('Korean', { title: 'Korean', url: 'https://play.google.com.evil.com/store/apps/details?id=com.x', description: '' }, true)).toBeNull();
});

it('fails closed for credentials, auth failures and long rate limits without uncontrolled retries', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 403 }));
  const http = new HttpClient({ fetchImpl, maxRetries: 0 });
  expect(() => braveSearchProvider(http, '')).toThrow();
  await expect(braveSearchProvider(http, 'key').search('test', 'US')).rejects.toThrow(/unavailable/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
