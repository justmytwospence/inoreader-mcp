export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface InoreaderSubscription {
  id: string;
  title: string;
  categories: Array<{ id: string; label: string }>;
  url: string;
  htmlUrl: string;
  iconUrl?: string;
  firstitemmsec?: string;
  sortid?: string;
}

export interface SubscriptionListResponse {
  subscriptions: InoreaderSubscription[];
}

export interface UnreadCount {
  id: string;
  count: number;
  newestItemTimestampUsec: string;
}

export interface UnreadCountResponse {
  max: number;
  unreadcounts: UnreadCount[];
}

export interface InoreaderIntelligenceSummary {
  id: string;
  prompt_id?: string;
  prompt_name?: string;
  custom_prompt?: string;
  prompt_icon?: string;
  summary: string;
  is_mobilized?: number;
}

/** One highlight on an article, as `stream/contents?annotations=1` returns it. */
export interface ArticleAnnotation {
  id: number | string;
  start?: number;
  end?: number;
  /** Unix seconds. */
  added_on?: number;
  /** The highlighted text. */
  text?: string;
  /** The user's note on the highlight, if any. */
  note?: string;
}

export interface ArticleItem {
  id: string;
  crawlTimeMsec: string;
  timestampUsec: string;
  published: number;
  updated?: number;
  title: string;
  summary?: { content: string };
  summaries?: InoreaderIntelligenceSummary[];
  canonical?: Array<{ href: string }>;
  alternate?: Array<{ href: string }>;
  origin?: {
    streamId: string;
    title: string;
    htmlUrl: string;
  };
  categories: string[];
  author?: string;
  /** Present only when requested with `annotations=1`. */
  annotations?: ArticleAnnotation[];
}

export interface StreamContentsResponse {
  direction: string;
  id: string;
  title: string;
  continuation?: string;
  items: ArticleItem[];
}

export interface StreamItemIdsResponse {
  itemRefs: Array<{ id: string; timestampUsec: string }>;
  continuation?: string;
}

export interface StreamItemContentsResponse {
  items: ArticleItem[];
}

export interface TagListResponse {
  tags: Array<{ id: string; sortid?: string; type?: string }>;
}

export interface UserInfoResponse {
  userId: string;
  userName: string;
  userProfileId: string;
  userEmail: string;
  isBloggerUser: boolean;
  signupTimeSec: number;
  isMultiLoginEnabled: boolean;
}

/**
 * `null` means "we have not been told", which is not the same as zero. Conflating
 * the two is what hid the broken header names: a limit of 0 rendered as "unknown"
 * and read like a display quirk rather than a parse failure.
 */
export interface ZoneState {
  limit: number | null;
  usage: number | null;
  /** Conservative admission floor for out-of-order responses; not a raw header. */
  conservativeUsage?: number;
  resetAfterSec: number | null;
  /** Timestamp of this zone's latest limit/usage header, not an unrelated response. */
  lastUpdated: number;
  limitObservedAt?: number;
  usageObservedAt?: number;
  usageExpiresAt?: number;
  resetObservedAt?: number;
  /** Monotone local attempt counter, independent of the UTC daily display. */
  attemptCount?: number;
  usageAttemptCount?: number;
  cooldownUntil?: number;
}

export interface RateLimitState {
  zone1: ZoneState;
  zone2: ZoneState;
  /** Fetch attempts initiated today; not necessarily charged. Other clients are unseen. */
  local: { dayKey: string; zone1Count: number; zone2Count: number };
  /** Any x-reader-* header we do not recognise, so a rename is visible. */
  unknownHeaders: Record<string, string>;
}
