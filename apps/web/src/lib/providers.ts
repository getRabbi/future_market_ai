/**
 * Connection forms per provider. Field keys match the connectors' ProviderCredentials
 * (packages/connectors/src/types.ts); `target: 'metadata'` fields go to connection metadata.
 * Secrets are sent once to the API, stored encrypted (FG_SECRETS_KEY) and never returned.
 */
export interface ConnectionField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  multiline?: boolean;
  placeholder?: string;
  help?: string;
  target?: 'credentials' | 'metadata';
}

export interface ProviderForm {
  provider: 'meta' | 'google_ads' | 'tiktok' | 'youtube' | 'shopify' | 'app_store_connect' | 'resend';
  name: string;
  enables: string;
  docsUrl: string;
  /** The external account this connection acts on (connections.externalAccountId). */
  account: { label: string; placeholder: string; help?: string; pattern?: RegExp; patternHint?: string; alsoCredential?: string };
  fields: ConnectionField[];
}

export const PROVIDER_FORMS: ProviderForm[] = [
  {
    provider: 'meta',
    name: 'Meta (Facebook, Instagram, Ads)',
    enables: 'Page and Instagram posts, comment replies, ad campaign sync and budgets.',
    docsUrl: 'https://developers.facebook.com/docs/facebook-login/guides/access-tokens',
    account: { label: 'Facebook Page ID', placeholder: '1234567890', help: 'Page settings → About → Page ID.', pattern: /^\d{5,20}$/, patternHint: 'digits only' },
    fields: [
      { key: 'accessToken', label: 'Page access token', secret: true, placeholder: 'EAAG…', help: 'For posts, comment replies and Instagram. With a system-user token, GET /{page-id}?fields=access_token returns a Page token that does not expire.' },
      { key: 'appSecret', label: 'App secret', secret: true, optional: true, help: 'Adds appsecret_proof to every call (recommended).' },
      { key: 'adAccountId', label: 'Ad account ID', optional: true, placeholder: 'act_1234567890', target: 'metadata', help: 'Only for ads: Business Settings → Ad accounts.' },
      { key: 'adsAccessToken', label: 'Ads access token', secret: true, optional: true, placeholder: 'EAAG…', help: 'Only for ads: a system-user token with ads_read and ads_management (Business Settings → System users). A Page token cannot read ad accounts.' },
    ],
  },
  {
    provider: 'google_ads',
    name: 'Google Ads',
    enables: 'Campaign and spend sync, reconciliation and budget changes.',
    docsUrl: 'https://developers.google.com/google-ads/api/docs/oauth/overview',
    account: { label: 'Customer ID', placeholder: '1234567890', help: 'Top of the Google Ads screen, without dashes.', pattern: /^\d{10}$/, patternHint: '10 digits, no dashes' },
    fields: [
      { key: 'developerToken', label: 'Developer token', secret: true, help: 'Google Ads → Admin → API Center.' },
      { key: 'clientId', label: 'OAuth client ID', placeholder: '…apps.googleusercontent.com', help: 'Google Cloud console → APIs & Services → Credentials.' },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true, help: 'From the OAuth consent flow with the adwords scope.' },
      { key: 'loginCustomerId', label: 'Manager account ID', optional: true, placeholder: '9876543210', help: 'Only when access goes through a manager (MCC) account.' },
    ],
  },
  {
    provider: 'tiktok',
    name: 'TikTok',
    enables: 'Video publishing (private until the app passes TikTok’s audit).',
    docsUrl: 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
    account: { label: 'TikTok open_id', placeholder: '-000abc…', help: 'Returned with the user access token.' },
    fields: [
      { key: 'accessToken', label: 'User access token', secret: true, placeholder: 'act.…' },
      { key: 'openId', label: 'open_id', optional: true, help: 'Same as the account above if you have it.' },
    ],
  },
  {
    provider: 'youtube',
    name: 'YouTube',
    enables: 'Video uploads and channel statistics.',
    docsUrl: 'https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps',
    account: { label: 'Channel ID', placeholder: 'UCxxxxxxxxxxxxxxxxxxxxxx', help: 'YouTube Studio → Settings → Channel → Advanced settings.', pattern: /^UC[\w-]{22}$/, patternHint: 'starts with UC, 24 characters' },
    fields: [
      { key: 'clientId', label: 'OAuth client ID', placeholder: '…apps.googleusercontent.com' },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true, help: 'From the OAuth consent flow with the youtube.upload and youtube.readonly scopes.' },
    ],
  },
  {
    provider: 'shopify',
    name: 'Shopify',
    enables: 'Orders for attribution, discounts and offer launches.',
    docsUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
    account: { label: 'Shop domain', placeholder: 'your-store.myshopify.com', pattern: /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, patternHint: 'your-store.myshopify.com', alsoCredential: 'shopDomain' },
    fields: [{ key: 'accessToken', label: 'Admin API access token', secret: true, placeholder: 'shpat_…', help: 'Shopify admin → Settings → Apps → Develop apps → your app → API credentials.' }],
  },
  {
    provider: 'app_store_connect',
    name: 'App Store Connect',
    enables: 'Store listing pushes and sales/download reports.',
    docsUrl: 'https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api',
    account: { label: 'App ID (Apple ID)', placeholder: '1234567890', help: 'App Store Connect → your app → App Information → Apple ID.' },
    fields: [
      { key: 'issuerId', label: 'Issuer ID', placeholder: '57246542-96fe-1a63-e053-0824d011072a', help: 'Users and Access → Integrations → App Store Connect API.' },
      { key: 'keyId', label: 'Key ID', placeholder: '2X9R4HXF34' },
      { key: 'privateKeyPem', label: 'Private key (.p8 file contents)', secret: true, multiline: true, placeholder: '-----BEGIN PRIVATE KEY-----' },
      { key: 'vendorNumber', label: 'Vendor number', optional: true, help: 'Payments and Financial Reports; needed for sales reports.' },
    ],
  },
  {
    provider: 'resend',
    name: 'Resend (email)',
    enables: 'Lifecycle and transactional email sending with delivery tracking.',
    docsUrl: 'https://resend.com/docs/dashboard/api-keys/introduction',
    account: { label: 'Sending domain', placeholder: 'mail.example.com', help: 'A domain verified in Resend (SPF/DKIM).' },
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 're_…' }],
  },
];

export const providerForm = (provider: string) => PROVIDER_FORMS.find((p) => p.provider === provider);
