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

export interface ArticleItem {
  id: string;
  crawlTimeMsec: string;
  timestampUsec: string;
  published: number;
  updated?: number;
  title: string;
  summary?: { content: string };
  canonical?: Array<{ href: string }>;
  alternate?: Array<{ href: string }>;
  origin?: {
    streamId: string;
    title: string;
    htmlUrl: string;
  };
  categories: string[];
  author?: string;
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

export interface RateLimitState {
  zone1: { limit: number; usage: number; resetAfterSec: number; lastUpdated: number };
  zone2: { limit: number; usage: number; resetAfterSec: number; lastUpdated: number };
}
