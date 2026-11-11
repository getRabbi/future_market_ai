import { getActionType } from '@futuregrow/contracts';
import { brandChannels, communityGroups, connections, creatorContracts, creators, type DbOrTx, growthChannelTasks, tenantSettings } from '@futuregrow/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { CoreDeps } from '../../deps.js';
import { senderIdentityComplete } from '../m24-governance/index.js';
import type { Channel, Settings } from './settings.js';
import { getBrandConfig } from './settings.js';

export interface ChannelReadiness {
  channel: Channel;
  /** A real, approved connector or workflow exists for this brand. */
  available: boolean;
  /** Execution path: M23 action type, a human workflow, or an internal record. */
  path: 'm23' | 'human' | 'internal';
  actionType: string | null;
  connectionId: string | null;
  connectionName: string | null;
  quota: number;
  usedToday: number;
  reason: string;
}

const DAY = 86_400_000;

/**
 * Which distribution channels a brand can really use right now. Only connected, active accounts
 * bound to the brand (or tenant-wide senders such as Resend) count; everything else is a human
 * task (owned website, partners, communities) or is reported as unavailable with the reason.
 */
export async function channelReadiness(t: DbOrTx, deps: Pick<CoreDeps, 'clock'>, brandId: string, s: Settings): Promise<ChannelReadiness[]> {
  const now = deps.clock.now();
  const { config } = await getBrandConfig(t, brandId);
  const bound = await t
    .select({ id: connections.id, provider: connections.provider, status: connections.status, scopes: connections.grantedScopes, name: connections.displayName, health: connections.healthStatus })
    .from(brandChannels)
    .innerJoin(connections, eq(connections.id, brandChannels.connectionId))
    .where(eq(brandChannels.brandId, brandId));
  const active = bound.filter((c) => c.status === 'active');
  const meta = active.find((c) => c.provider === 'meta');
  const ig = active.find((c) => c.provider === 'meta' && c.scopes.includes('instagram_content_publish'));
  const [resend] = await t
    .select({ id: connections.id, name: connections.displayName })
    .from(connections)
    .where(and(eq(connections.provider, 'resend'), eq(connections.status, 'active')))
    .limit(1);
  const [sender] = await t.select({ senderIdentity: tenantSettings.senderIdentity }).from(tenantSettings).limit(1);
  const ads = active.find((c) => c.provider === 'meta' || c.provider === 'google_ads');
  const [creatorCount] = await t
    .select({ n: sql<number>`count(distinct ${creators.id})::int` })
    .from(creators)
    .innerJoin(creatorContracts, eq(creatorContracts.creatorId, creators.id))
    .where(eq(creators.status, 'active'));
  const [groups] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(communityGroups)
    .where(and(inArray(communityGroups.status, ['member', 'approved']), inArray(communityGroups.permission, ['members_may_post', 'admin_approval', 'owned'])));
  const used = await t
    .select({ channel: growthChannelTasks.channel, n: sql<number>`count(*)::int` })
    .from(growthChannelTasks)
    .where(and(eq(growthChannelTasks.brandId, brandId), gte(growthChannelTasks.submittedAt, new Date(now.getTime() - DAY))))
    .groupBy(growthChannelTasks.channel);
  const usedOf = (ch: Channel) => used.find((u) => u.channel === ch)?.n ?? 0;
  const quota = (ch: Channel) => s.effective.channelQuotas[ch] ?? 0;
  const supported = (type: string) => getActionType(type)?.supported === true;
  const row = (channel: Channel, r: Omit<ChannelReadiness, 'channel' | 'quota' | 'usedToday'>): ChannelReadiness => ({ channel, quota: quota(channel), usedToday: usedOf(channel), ...r });
  const senderReady = senderIdentityComplete(sender?.senderIdentity ?? null);
  return [
    row(
      'facebook',
      meta && supported('social.facebook.publish_post')
        ? { available: true, path: 'm23', actionType: 'social.facebook.publish_post', connectionId: meta.id, connectionName: meta.name, reason: `Page ${meta.name} is connected (health ${meta.health}); posts go through M16 copy lint and M23 policy/approval.` }
        : { available: false, path: 'm23', actionType: 'social.facebook.publish_post', connectionId: null, connectionName: null, reason: 'No active Facebook Page is bound to this brand (Channels › Brand studio).' },
    ),
    row(
      'instagram',
      ig && supported('social.instagram.publish_media')
        ? { available: true, path: 'm23', actionType: 'social.instagram.publish_media', connectionId: ig.id, connectionName: ig.name, reason: `${ig.name} grants instagram_content_publish; Instagram posts need an approved image.` }
        : { available: false, path: 'm23', actionType: 'social.instagram.publish_media', connectionId: null, connectionName: null, reason: 'No bound Meta connection grants instagram_content_publish.' },
    ),
    row(
      'email',
      resend && senderReady
        ? { available: true, path: 'm23', actionType: 'email.send', connectionId: resend.id, connectionName: resend.name, reason: 'Resend is connected and a sender identity is set; email goes only to consented, unsuppressed people through M20 journeys and M23.' }
        : { available: false, path: 'm23', actionType: 'email.send', connectionId: resend?.id ?? null, connectionName: resend?.name ?? null, reason: resend ? 'Set the sender identity (Governance) before email can be used.' : 'No active Resend connection.' },
    ),
    row(
      'paid_ads',
      ads && s.controls.paidOperations && s.controls.adSpendLimitMicros > 0
        ? {
            available: true,
            path: 'human',
            actionType: ads.provider === 'meta' ? 'ads.meta.create_campaign' : 'ads.google.create_campaign',
            connectionId: ads.id,
            connectionName: ads.name,
            reason: 'Paid proposals stay proposals: a person creates the campaign (PAUSED, always approved) in Ads › Campaign creation within the advertising limit.',
          }
        : { available: false, path: 'human', actionType: null, connectionId: ads?.id ?? null, connectionName: ads?.name ?? null, reason: !ads ? 'No ad account is bound to this brand.' : 'Paid operations are off or the advertising limit is 0 (Growth settings).' },
    ),
    row(
      'owned_site',
      config.landingUrl
        ? { available: true, path: 'human', actionType: null, connectionId: null, connectionName: null, reason: `A person publishes the prepared page on ${new URL(config.landingUrl).host}; FUTUREGROW has no write access to the website.` }
        : { available: false, path: 'human', actionType: null, connectionId: null, connectionName: null, reason: 'Set the brand landing URL in the brand growth profile.' },
    ),
    row(
      'referral',
      (creatorCount?.n ?? 0) > 0
        ? { available: true, path: 'internal', actionType: null, connectionId: null, connectionName: null, reason: `${creatorCount!.n} active creator(s) with contracts; referral links are tracked by M22 (no payout is triggered).` }
        : { available: false, path: 'internal', actionType: null, connectionId: null, connectionName: null, reason: 'No active creator with a contract (Creators & referrals).' },
    ),
    row('partner', { available: true, path: 'human', actionType: null, connectionId: null, connectionName: null, reason: 'Partner distribution is a human task with a tagged link; nothing is sent automatically.' }),
    row(
      'community',
      (groups?.n ?? 0) > 0
        ? { available: true, path: 'human', actionType: null, connectionId: null, connectionName: null, reason: `${groups!.n} community destination(s) allow posting; a member shares the kit by hand after reading the group rules.` }
        : { available: false, path: 'human', actionType: null, connectionId: null, connectionName: null, reason: 'No community destination where posting is permitted (Content studio › Communities).' },
    ),
    row(
      'creator',
      (creatorCount?.n ?? 0) > 0
        ? { available: true, path: 'internal', actionType: null, connectionId: null, connectionName: null, reason: 'Creator briefs go to contracted creators; their submissions are reviewed in M22.' }
        : { available: false, path: 'internal', actionType: null, connectionId: null, connectionName: null, reason: 'No active creator with a contract.' },
    ),
  ];
}
