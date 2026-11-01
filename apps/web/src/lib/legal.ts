/**
 * Operator details shown on /privacy, /terms and /data-deletion. Only verified details: the operator
 * is the Meta Business that owns the "futuregrowth" app, the contact is the owner account's email.
 */
export const LEGAL = {
  operator: 'Futuregrowth',
  contactEmail: 'uprightseo24@gmail.com',
  metaApp: 'futuregrowth',
  effective: '1 November 2026',
  site: 'https://futuregrow.scalemyprints.com',
} as const;

/** Third parties that process personal data for FUTUREGROW itself (not platforms an organization connects). */
export const SERVICE_PROVIDERS = [
  { name: 'Northflank', role: 'Application hosting, background workers and the main database', location: 'United States' },
  { name: 'Cloudflare', role: 'Website delivery, DNS and network protection; file storage and encrypted backups (R2)', location: 'Global network; stored files in the Asia-Pacific region' },
  { name: 'Groq', role: 'AI model inference for ideas, briefs and drafts', location: 'United States and other Groq data centres' },
  { name: 'Have I Been Pwned (Pwned Passwords)', role: 'Checks whether a new password appears in known breaches. Only the first five characters of a hash of the password are sent, never the password.', location: 'Global (Cloudflare network)' },
] as const;

/** Meta permissions a connection can hold and what FUTUREGROW does with each (packages/connectors/src/providers/meta.ts). */
export const META_PERMISSIONS = [
  { scope: 'pages_manage_posts', use: 'Publishes Page posts that the organization’s publishing policy and approvers allow.' },
  { scope: 'pages_read_engagement', use: 'Reads the Page profile, its posts and their reaction, comment and share counts, to confirm a post was published and measure results.' },
  { scope: 'pages_read_user_content', use: 'Reads comments and mentions on the Page so the organization can review them.' },
  { scope: 'pages_manage_engagement', use: 'Publishes replies to comments that the organization approves.' },
  { scope: 'pages_manage_metadata', use: 'Subscribes the Page to Meta’s notifications about new comments and mentions.' },
  { scope: 'read_insights', use: 'Reads Page insights (for example daily post engagements), only if a Page admin grants it.' },
  { scope: 'ads_read', use: 'Reads a connected ad account’s campaigns and daily spend.' },
  { scope: 'ads_management', use: 'Changes a campaign’s budget or status, only after the organization’s approvers approve that change.' },
  { scope: 'pages_show_list, business_management, pages_manage_ads, public_profile', use: 'May be granted when signing in with Facebook; FUTUREGROW does not use them to read or change anything.' },
] as const;
