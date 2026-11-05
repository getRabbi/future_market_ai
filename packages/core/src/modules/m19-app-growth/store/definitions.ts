/**
 * Official store report families FUTUREGROW imports (D-045). Every metric keeps the provider's own
 * column name and definition; nothing here invents a dimension a report does not carry.
 *
 * Sources (checked 2026-11-06):
 * - Google Play bulk reports: support.google.com/googleplay/android-developer/answer/6135870
 *   (paths, dimensions, columns; statistics are posted "within 3 to 7 days" in monthly CSVs).
 * - Play Developer Reporting API v1beta1 discovery document (vitals metric sets; DAILY uses
 *   America/Los_Angeles).
 * - Apple Analytics Reports: developer.apple.com/documentation/analytics-reports (App Store
 *   Downloads, Discovery and Engagement, Installations and Deletions, App Sessions, App Crashes;
 *   newer instances overwrite older ones for the same Date).
 */

export type StorePlatform = 'android' | 'ios';
export type StoreProvider = 'google_play' | 'app_store_connect';

/**
 * How values combine. `sum`: additive across days and listed dimension values. `snapshot`: a level
 * on a day (take the latest, never add days). `ratio`/`mean`: as reported for that day only.
 * `daily_unique`: a daily unique count; a range total is a sum of daily values, not unique people.
 */
export type Aggregation = 'sum' | 'daily_unique' | 'snapshot' | 'ratio' | 'mean';

export interface MetricDefinition {
  key: string;
  label: string;
  unit: 'count' | 'devices' | 'users' | 'events' | 'ratio' | 'rating' | 'seconds';
  aggregation: Aggregation;
  /** Who is counted (populations differ between sources and must not be mixed). */
  population: string;
  /** The provider's definition, paraphrased closely, with its source. */
  definition: string;
}

export interface PlayDimension {
  /** Report file suffix. */
  suffix: string;
  /** Normalized dimension key stored on observations. */
  key: string;
  /** Header names the dimension column may carry (matched case-insensitively). */
  columns: string[];
  /** Normalized dims field names, in column order (traffic_source has several). */
  fields: { name: string; columns: string[] }[];
  /** Imported unless the account disables it. */
  defaultOn: boolean;
}

export interface PlayFamily {
  provider: 'google_play';
  family: string;
  label: string;
  /** Folder and file stem: `stats/installs/installs_<package>_<yyyyMM>_<dimension>.csv`. */
  folder: string;
  stem: string;
  dimensions: PlayDimension[];
  /** Report column → metric. */
  metrics: Record<string, MetricDefinition>;
}

const PLAY_DOC = 'Google Play Console, Download and export monthly reports';

const playMetric = (key: string, label: string, unit: MetricDefinition['unit'], aggregation: Aggregation, population: string, definition: string): MetricDefinition => ({ key, label, unit, aggregation, population, definition: `${definition} (${PLAY_DOC}).` });

const dim = (suffix: string, key: string, columns: string[], defaultOn: boolean): PlayDimension => ({ suffix, key, columns, fields: columns.length ? [{ name: key, columns }] : [], defaultOn });

/** Statistics files with no documented "overview" suffix are still accepted when Google ships one. */
const OVERVIEW = dim('overview', 'overview', [], true);
const COUNTRY = dim('country', 'country', ['Country', 'Country/region', 'Country / region'], true);
const APP_VERSION = dim('app_version', 'app_version', ['App Version Code', 'App version code', 'App Version', 'App version'], true);

export const PLAY_FAMILIES: PlayFamily[] = [
  {
    provider: 'google_play',
    family: 'play.installs',
    label: 'Installs (Play statistics)',
    folder: 'stats/installs',
    stem: 'installs',
    dimensions: [OVERVIEW, COUNTRY, APP_VERSION, dim('device', 'device', ['Device'], false), dim('language', 'language', ['Language'], false), dim('os_version', 'os_version', ['Android OS Version', 'OS Version', 'Android OS version'], false), dim('carrier', 'carrier', ['Carrier'], false)],
    metrics: {
      'Daily Device Installs': playMetric('play.daily_device_installs', 'Device installs', 'devices', 'sum', 'devices', 'Devices on which the app was installed on the day'),
      'Daily Device Uninstalls': playMetric('play.daily_device_uninstalls', 'Device uninstalls', 'devices', 'sum', 'devices', 'Devices from which the app was uninstalled on the day'),
      'Daily Device Upgrades': playMetric('play.daily_device_upgrades', 'Device upgrades', 'devices', 'sum', 'devices', 'Devices on which the app was updated on the day'),
      'Daily User Installs': playMetric('play.daily_user_installs', 'User installs', 'users', 'sum', 'Google accounts', 'Users who installed the app on the day'),
      'Daily User Uninstalls': playMetric('play.daily_user_uninstalls', 'User uninstalls', 'users', 'sum', 'Google accounts', 'Users who uninstalled the app on the day'),
      'Current Device Installs': playMetric('play.current_device_installs', 'Current device installs', 'devices', 'snapshot', 'devices', 'Devices with the app currently installed'),
      'Installs on active devices': playMetric('play.installs_on_active_devices', 'Installs on active devices', 'devices', 'snapshot', 'active devices', 'Active devices with the app installed'),
      'Current User Installs': playMetric('play.current_user_installs', 'Current user installs', 'users', 'snapshot', 'Google accounts', 'Users with the app currently installed on at least one device'),
      'Total User Installs': playMetric('play.total_user_installs', 'Total user installs', 'users', 'snapshot', 'Google accounts', 'Cumulative users who have ever installed the app'),
    },
  },
  {
    provider: 'google_play',
    family: 'play.store_performance',
    label: 'Store performance (listing acquisitions)',
    folder: 'stats/store_performance',
    stem: 'store_performance',
    dimensions: [
      COUNTRY,
      {
        suffix: 'traffic_source',
        key: 'traffic_source',
        columns: ['Traffic source'],
        fields: [
          { name: 'traffic_source', columns: ['Traffic source'] },
          { name: 'search_term', columns: ['Search term'] },
          { name: 'utm_source', columns: ['UTM source'] },
          { name: 'utm_campaign', columns: ['UTM campaign'] },
        ],
        defaultOn: true,
      },
    ],
    metrics: {
      'Store listing acquisitions': playMetric('play.store_listing_acquisitions', 'Store listing acquisitions', 'users', 'sum', 'store listing visitors who installed', 'Users who visited the store listing and installed the app; values below Google’s thresholds are reported as "Other"'),
      'Store listing visitors': playMetric('play.store_listing_visitors', 'Store listing visitors', 'users', 'daily_unique', 'store listing visitors', 'Users who visited the store listing on the day'),
      'Store listing conversion rate': playMetric('play.store_listing_conversion_rate', 'Listing conversion rate (as reported)', 'ratio', 'ratio', 'store listing visitors', 'Acquisitions divided by visitors, as calculated by Google for the row'),
    },
  },
  {
    provider: 'google_play',
    family: 'play.crashes',
    label: 'Crashes and ANRs (Play statistics)',
    folder: 'stats/crashes',
    stem: 'crashes',
    dimensions: [OVERVIEW, APP_VERSION, dim('device', 'device', ['Device'], false), dim('os_version', 'os_version', ['Android OS Version', 'OS Version', 'Android OS version'], false)],
    metrics: {
      'Daily Crashes': playMetric('play.daily_crashes', 'Crashes', 'events', 'sum', 'crash reports', 'Crashes reported on the day'),
      'Daily ANRs': playMetric('play.daily_anrs', 'ANRs', 'events', 'sum', 'ANR reports', '"Application not responding" events reported on the day'),
    },
  },
  {
    provider: 'google_play',
    family: 'play.ratings',
    label: 'Ratings (Play statistics)',
    folder: 'stats/ratings',
    stem: 'ratings',
    dimensions: [OVERVIEW, COUNTRY, APP_VERSION, dim('device', 'device', ['Device'], false), dim('language', 'language', ['Language'], false)],
    metrics: {
      'Daily Average Rating': playMetric('play.daily_average_rating', 'Average rating (day)', 'rating', 'mean', 'ratings submitted', 'Average of the ratings submitted on the day; empty when none were submitted'),
      'Total Average Rating': playMetric('play.total_average_rating', 'Average rating (all time)', 'rating', 'snapshot', 'all ratings', 'Average of all ratings up to the day'),
    },
  },
];

/** Vitals from the Play Developer Reporting API, stored like a report (one source per query). */
export const PLAY_VITALS = {
  family: 'play.vitals',
  label: 'Android vitals (Play Developer Reporting API)',
  timezone: 'America/Los_Angeles',
  metrics: {
    crashRate: { key: 'play.vitals.crash_rate', label: 'Crash rate', unit: 'ratio', aggregation: 'ratio', population: 'distinct users (daily)', definition: 'Share of distinct users in the day who experienced at least one crash (Play Developer Reporting API crashRateMetricSet).' },
    userPerceivedCrashRate: { key: 'play.vitals.user_perceived_crash_rate', label: 'User-perceived crash rate', unit: 'ratio', aggregation: 'ratio', population: 'distinct users (daily)', definition: 'Share of distinct users with a crash while the app was in active use (crashRateMetricSet).' },
    anrRate: { key: 'play.vitals.anr_rate', label: 'ANR rate', unit: 'ratio', aggregation: 'ratio', population: 'distinct users (daily)', definition: 'Share of distinct users in the day who experienced at least one ANR (anrRateMetricSet).' },
    userPerceivedAnrRate: { key: 'play.vitals.user_perceived_anr_rate', label: 'User-perceived ANR rate', unit: 'ratio', aggregation: 'ratio', population: 'distinct users (daily)', definition: 'Share of distinct users with a user-perceived ANR (anrRateMetricSet).' },
  } satisfies Record<string, MetricDefinition>,
} as const;

/* ------------------------------------------------------------------ */
/* Apple Analytics Reports (Standard, DAILY instances)                  */
/* ------------------------------------------------------------------ */

const APPLE_DOC = 'Apple Analytics Reports';

export interface AppleFamily {
  provider: 'app_store_connect';
  family: string;
  label: string;
  /** Report names as listed by `analyticsReportRequests/{id}/reports` (Standard content level). */
  names: RegExp;
  category: string;
  /** Days after which a Date is complete (each report's "Completeness"). */
  completenessDays: number;
  /** Columns that must be present. */
  required: string[];
  /** Kept dimensions (others are summed over, which is valid only for additive Counts). */
  dims: { name: string; column: string }[];
  /** Column that splits rows into metrics (Download Type, Event), or null. */
  splitColumn: string | null;
  /** Measure column → metric per split value ('*' = any value). */
  measures: { column: string; split: Record<string, MetricDefinition> }[];
}

const appleMetric = (key: string, label: string, unit: MetricDefinition['unit'], population: string, definition: string): MetricDefinition => ({ key, label, unit, aggregation: 'sum', population, definition: `${definition} (${APPLE_DOC}).` });
const OPT_IN = 'users who agreed to share data with Apple and developers';

export const APPLE_FAMILIES: AppleFamily[] = [
  {
    provider: 'app_store_connect',
    family: 'asc.downloads',
    label: 'App Store downloads',
    names: /^app (store )?downloads? standard$/i,
    category: 'COMMERCE',
    completenessDays: 2,
    required: ['Date', 'App Apple Identifier', 'Download Type', 'Territory', 'Counts'],
    dims: [
      { name: 'territory', column: 'Territory' },
      { name: 'source_type', column: 'Source Type' },
    ],
    splitColumn: 'Download Type',
    measures: [
      {
        column: 'Counts',
        split: {
          'first-time download': appleMetric('asc.first_time_downloads', 'First-time downloads', 'count', 'Apple accounts', 'The first time an Apple account downloaded the app (tapped Buy or Get)'),
          redownload: appleMetric('asc.redownloads', 'Redownloads', 'count', 'Apple accounts', 'A later installation of the app by the same Apple account'),
          'manual update': appleMetric('asc.manual_updates', 'Manual updates', 'count', 'devices', 'Updates started with the Update button'),
          'auto-update': appleMetric('asc.auto_updates', 'Auto-updates', 'count', 'devices', 'Automatic updates'),
          restore: appleMetric('asc.restores', 'Restores', 'count', 'devices', 'Restores from iCloud Backup'),
        },
      },
    ],
  },
  {
    provider: 'app_store_connect',
    family: 'asc.engagement',
    label: 'App Store discovery and engagement',
    names: /^app store discovery and engagement standard$/i,
    category: 'APP_STORE_ENGAGEMENT',
    completenessDays: 3,
    required: ['Date', 'App Apple Identifier', 'Event', 'Territory', 'Counts'],
    dims: [
      { name: 'territory', column: 'Territory' },
      { name: 'source_type', column: 'Source Type' },
      { name: 'page_type', column: 'Page Type' },
    ],
    splitColumn: 'Event',
    measures: [
      {
        column: 'Counts',
        split: {
          impression: appleMetric('asc.impressions', 'Impressions', 'events', 'App Store users', 'The app icon was shown in a list with other apps (search results, charts, Today/Apps/Games tabs)'),
          'page view': appleMetric('asc.page_views', 'Page views', 'events', 'App Store users', 'A dedicated page for the app or an in-app event was shown'),
          tap: appleMetric('asc.taps', 'Taps', 'events', 'App Store users', 'A tap on an impression or page'),
        },
      },
    ],
  },
  {
    provider: 'app_store_connect',
    family: 'asc.installs',
    label: 'Installations and deletions',
    names: /^app store installations? and deletions? standard$/i,
    category: 'APP_USAGE',
    completenessDays: 5,
    required: ['Date', 'App Apple Identifier', 'Event', 'Territory', 'Counts'],
    dims: [
      { name: 'territory', column: 'Territory' },
      { name: 'source_type', column: 'Source Type' },
      { name: 'download_type', column: 'Download Type' },
    ],
    splitColumn: 'Event',
    measures: [
      {
        column: 'Counts',
        split: {
          install: appleMetric('asc.installations', 'Installations', 'events', OPT_IN, 'The app was installed on a device'),
          delete: appleMetric('asc.deletions', 'Deletions', 'events', OPT_IN, 'The app was deleted from a device'),
        },
      },
    ],
  },
  {
    provider: 'app_store_connect',
    family: 'asc.sessions',
    label: 'App sessions',
    names: /^app sessions standard$/i,
    category: 'APP_USAGE',
    completenessDays: 5,
    required: ['Date', 'App Apple Identifier', 'Territory', 'Sessions'],
    dims: [
      { name: 'territory', column: 'Territory' },
      { name: 'source_type', column: 'Source Type' },
    ],
    splitColumn: null,
    measures: [
      { column: 'Sessions', split: { '*': appleMetric('asc.sessions', 'Sessions', 'events', OPT_IN, 'Number of app sessions') } },
      { column: 'Total Session Duration', split: { '*': appleMetric('asc.session_duration_seconds', 'Session time', 'seconds', OPT_IN, 'Total duration, in seconds, of the reported sessions') } },
    ],
  },
  {
    provider: 'app_store_connect',
    family: 'asc.crashes',
    label: 'App crashes',
    names: /^app crashes$/i,
    category: 'APP_USAGE',
    completenessDays: 5,
    required: ['Date', 'App Apple Identifier', 'Crashes'],
    dims: [{ name: 'app_version', column: 'App Version' }],
    splitColumn: null,
    measures: [{ column: 'Crashes', split: { '*': appleMetric('asc.crashes', 'Crashes', 'events', `${OPT_IN}; only when at least five users report`, 'Total number of crashes') } }],
  },
];

/** Every metric key FUTUREGROW stores, with its definition (served to the dashboard). */
export const METRIC_DEFINITIONS: Record<string, MetricDefinition & { provider: StoreProvider; family: string; sourceMetric: string }> = Object.fromEntries([
  ...PLAY_FAMILIES.flatMap((f) => Object.entries(f.metrics).map(([col, m]) => [m.key, { ...m, provider: 'google_play' as const, family: f.family, sourceMetric: col }])),
  ...Object.entries(PLAY_VITALS.metrics).map(([name, m]) => [m.key, { ...(m as MetricDefinition), provider: 'google_play' as const, family: PLAY_VITALS.family, sourceMetric: name }]),
  ...APPLE_FAMILIES.flatMap((f) => f.measures.flatMap((ms) => Object.values(ms.split).map((m) => [m.key, { ...m, provider: 'app_store_connect' as const, family: f.family, sourceMetric: ms.column }]))),
]);

export const playFamily = (family: string) => PLAY_FAMILIES.find((f) => f.family === family) ?? null;
export const appleFamily = (family: string) => APPLE_FAMILIES.find((f) => f.family === family) ?? null;

/** Bulk statistics are posted within 3–7 days; a day older than this is treated as final. */
export const PLAY_POSTING_DAYS = 7;

/**
 * Headline KPIs per platform for overviews and the Growth Brain. Each is one metric with one
 * definition; Android and iOS headline metrics are never added together.
 */
export const HEADLINE_METRICS: Record<StorePlatform, { acquisition: string[]; installs: string[]; quality: string[] }> = {
  android: {
    acquisition: ['play.store_listing_acquisitions', 'play.store_listing_visitors'],
    installs: ['play.daily_user_installs', 'play.daily_device_installs', 'play.daily_user_uninstalls', 'play.daily_device_uninstalls'],
    quality: ['play.daily_crashes', 'play.daily_anrs', 'play.vitals.crash_rate', 'play.vitals.anr_rate'],
  },
  ios: { acquisition: ['asc.first_time_downloads', 'asc.page_views', 'asc.impressions'], installs: ['asc.installations', 'asc.deletions'], quality: ['asc.crashes'] },
};
