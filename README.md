# inoreader-mcp

MCP server for the [Inoreader](https://www.inoreader.com) RSS reader API. Lets Claude help you triage articles, analyze feed health, and manage subscriptions.

## Setup

### 1. Create an Inoreader API application

Go to the [Inoreader Developer Portal](https://www.inoreader.com/developers/) and create a new application.

- Set the redirect URI to `http://localhost:3333/callback`
- Note your **Client ID** and **Client Secret**

### 2. Install

This project is **not** published to npm. The name `inoreader-mcp` on the npm registry
belongs to an unrelated project, so `npx inoreader-mcp` installs someone else's code.
Build it from source instead:

```bash
git clone https://github.com/justmytwospence/inoreader-mcp
cd inoreader-mcp
npm install && npm run build
```

### 3. Add to Claude Code

```bash
claude mcp add -s user \
  -e INOREADER_CLIENT_ID=your-client-id \
  -e INOREADER_CLIENT_SECRET=your-client-secret \
  inoreader -- node /absolute/path/to/inoreader-mcp/dist/index.js
```

Or for Claude Desktop, add to your config file:

```json
{
  "mcpServers": {
    "inoreader": {
      "command": "node",
      "args": ["/absolute/path/to/inoreader-mcp/dist/index.js"],
      "env": {
        "INOREADER_CLIENT_ID": "your-client-id",
        "INOREADER_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### 4. Authenticate

On first use, ask Claude to call the `setup_auth` tool. It will give you an OAuth URL to open in your browser. After authorizing, copy the `code` parameter from the redirect URL and pass it back. Tokens are saved to `~/.config/inoreader-mcp/tokens.json` and refresh automatically.

### Or run it as a service (Docker)

```sh
cp .env.example .env   # fill in the INOREADER_* values
docker compose up -d
```

The server then speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28)
at `http://<host>:8000/mcp` (also at `/`), with a health check at `/health`, for 2026-07-28 and
older session-based clients alike. Running as a service adds two things a stdio process cannot do:

- **It receives the OAuth redirect.** Set `INOREADER_REDIRECT_URI` (and the redirect URI on your
  Inoreader app) to `https://<this server>/callback`. `setup_auth` then returns a link; authorize,
  land on `/callback`, and the tokens are saved. Nothing to paste.
- **It keeps the grant alive.** Inoreader's refresh token expires on its own after a couple of weeks
  unused, so the server refreshes it every `INOREADER_KEEPALIVE_HOURS` (default 12) and, if
  `NTFY_URL` + `NTFY_TOPIC` are set, pushes an alert when a refresh fails.

| Variable | Default | Meaning |
|---|---|---|
| `INOREADER_CLIENT_ID`, `INOREADER_CLIENT_SECRET` | (required) | Your Inoreader app |
| `INOREADER_REDIRECT_URI` | `http://localhost:3333/callback` | Must byte-match the app's redirect URI |
| `INOREADER_CONFIG_DIR` | `~/.config/inoreader-mcp` (`/data` in compose) | Token and rate-limit state |
| `INOREADER_KEEPALIVE_HOURS` | `12` | Refresh interval in HTTP mode; `0` disables |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | (unset) | Optional ntfy alerts for failed refreshes |
| `MCP_TRANSPORT` | `stdio` (`http` in the image) | `stdio` or `http` |
| `PORT` | `8000` | HTTP port |
| `MCP_ALLOWED_HOSTS` | (any) | Comma-separated hostnames allowed in the `Host` header (set it behind a reverse proxy) |

Images: `ghcr.io/justmytwospence/inoreader-mcp`, published for amd64 and arm64 by pushing a
`vX.Y.Z` tag.

## Resources

Context that MCP clients can read directly without tool calls.

| Resource | URI | Description | API Cost |
|----------|-----|-------------|----------|
| `usage` | `inoreader://usage` | Local guide: costs, limits, all template examples and prompt names | 0 |
| `rate-limits` | `inoreader://rate-limits` | Cached header observations, local attempt estimates, reset/cooldown timestamps | 0 |
| `subscriptions` | `inoreader://subscriptions` | First 500 feeds with id, title, URL and folders; total/truncation disclosed | 1 Z1 |
| `folders` | `inoreader://folders` | First 500 folders and tags each; totals/truncation disclosed | 2 Z1 |
| `unread-counts` | `inoreader://unread-counts` | First 500 non-zero counts, descending; feed/folder counts overlap | 1 Z1 |

Article content template: `inoreader://articles/{article_id}/content?max_chars={max_chars}`.
Percent-encode the ID and supply a required integer `max_chars` from 1 to 20000;
for example `inoreader://articles/123/content?max_chars=8000`. Reading it costs one
Zone 1 content POST (safe-read retries extra). It returns bounded **stored HTML**,
truncation and provenance, never starts full-text extraction or paid processing.
The static usage guide includes these examples for clients that do not list templates
or consume initialize instructions. Discovery and prompt retrieval perform no HTTP
or account writes; live resource reads use the same authorized API as tools.

## Tools

### API primitives

Thin wrappers around individual Inoreader API endpoints.

#### Reading

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_unread_counts` | Unread counts for all feeds/folders, sorted by count | 1 Z1 |
| `get_articles` | Fetch articles with filters (stream, status, date range, pagination). `compact=true` returns id/title/source/flags only (~10x smaller). `include_total=false` skips the count request. | 1-2 Z1/page |
| `get_article_ids` | Lightweight ID-only fetch for counting/batch ops. Use `get_articles(compact=true)` for a middle ground with titles. | 1 Z1 |
| `get_article_content` | Full HTML content for specific articles by ID | 1 Z1 |
| `search_articles` | Keyword search across all feeds. Supports `compact=true`. | 1 Z1/page |

#### Subscriptions

| Tool | Description | API Cost |
|------|-------------|----------|
| `list_subscriptions` | All feeds with folders, URLs, metadata | 1 Z1 |
| `manage_subscription` | Subscribe, edit (rename/move), or unsubscribe | Subscribe 1-2 Z2; edit 1 Z2 + 1 Z1; unsubscribe 1 Z2 |

#### Organization

| Tool | Description | API Cost |
|------|-------------|----------|
| `manage_tags` | Mark read/unread/starred, apply/remove tags (batch support), verified | 1 Z2 + 1 Z1 per 50, up to 2 rounds |
| `batch_manage_tags` | Grouped tag edits with read-back verification | 1 Z2 per 50 sharing an add/remove pair + 1 Z1 per 50 intents, up to 2 rounds |
| `mark_all_read` | Mark all items in a feed/folder as read | 1 Z2 |
| `list_folders_and_tags` | All folders and tags with unread counts (unread only; use `get_article_ids` for paged counts) | 2 Z1 |

#### Account

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_user_info` | Authenticated user info | 1 Z1 |
| `get_rate_limit_status` | Check remaining API budget (reads persisted state) | 0 |

### Composite tools

Higher-level workflows that combine multiple API calls or add client-side logic.

#### Feed management

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_uncategorized_feeds` | Feeds with no folder, as compact tuples | 1 Z1 |
| `suggest_feed_cleanup` | Deterministic cleaned-up title proposals for uncategorized feeds — strips vendor boilerplate (`Blog on X`, `X's Blog`, trailing `RSS`/`Feed`, redundant site suffix). Read-only; apply with `manage_subscription`. | 1 Z1 |
| `categorize_feeds` | Verified bulk folder assignment from `{folder: [id, ...]}` | 1 Z2/assignment + 1-3 Z1; reconciliation adds up to 1 Z2/shortfall |
| `reassign_feeds` | Verified moves require destination present AND source absent | 1 Z2/assignment + 1-3 Z1; reconciliation adds up to 2 Z2/shortfall |
| `find_feed_replacement` | For a broken feed: where the old address redirects, the feeds its site advertises, and conventional paths, each compared with the posts Inoreader stored from the old feed. `high` = shares posts or is the redirect target, `medium` = same site only. Read-only; refuses private network addresses. | 2 Z1 + site fetches |
| `replace_feed` | Swap a subscription to a new feed URL keeping its title and folders; the old one is removed only after the new one is confirmed. | 2-3 Z2 + 3 Z1 |
| `analyze_feeds` | Bayesian feed health analysis with category-level priors. Degrades and reports rather than exhausting the read budget. | 3 + pages [+ 1 Z1/feed for volume] |

#### Saved items

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_saved_items` | Bounded, deduplicated union with `saved_via`, `complete`, per-collection continuation/errors | Up to 3 × `max_pages_per_collection` Z1 (default 1, max 10) |
| `get_saved_web_pages` | List saved pages with `removable` filter (excludes starred and `keep`-tagged). Supports `compact=true`. | 1 Z1/page |
| `remove_saved_web_pages` | Batch-remove saved pages by ID. Verified. | 1 Z2 + 1 Z1 per 50, up to 2 rounds |

#### Classifier calibration

| Tool | Description | API Cost |
|------|-------------|----------|
| `extract_classifier_data` | Read existing Intelligence summaries; cap flags disclose partial coverage, errors fail loudly | 4-80 Z1 + optional population pages (default 30, max 200) |
| `analyze_classifier_calibration` | Reliability diagram, ECE, monotonicity violations, threshold diagnostic, Manski FNR bounds, audit-conditional recall posterior | same as extract |
| `recommend_audit_articles` | Active-learning suggestions for which recommend-skip articles to audit | same as extract |

Starred articles, saved web pages, and Keep-tagged items are separate, overlapping streams.
`get_saved_items` reads at most 100 items per page per collection; `total_count`,
`by_collection` and `saved_via` describe the fetched pages, not the whole account
unless `complete=true`. Resume individual streams with `get_articles` and the reported
continuation; membership may be incomplete while pages remain. `count_only` in
`get_saved_web_pages` counts one IDs page of at most 10000, with `total_is_exact`
and continuation, not an unconditional account total.

The `keep` tag (via `manage_tags add_tag='keep'`) protects a page from cleanup without starring it. Use `get_saved_web_pages(filter='removable')` for pages that are neither starred nor kept.

**Z1** = Zone 1 (read), **Z2** = Zone 2 (write). Costs above are base requests;
safe-read retries are additional attempts. Read `inoreader://usage` and
`get_rate_limit_status` before expensive work. All 29 tools explicitly declare all
four safety hints; these are advisory, not authorization or approval enforcement.
JSON text results are preserved alongside structured data (legacy top-level arrays
appear under `structuredContent.items`). Output schemas are declared and validated
for stable ID/saved-union/folder-write shapes.

## Prompts

Pre-built workflows that combine resources and tools into guided tasks.

| Prompt | Description | Arguments |
|--------|-------------|-----------|
| `triage-unread` | Review unread articles, summarize each, suggest read/star/skip | `folder?`, `count?` |
| `feed-health-review` | Analyze feed engagement, identify unsubscribe candidates | `months?`, `folder?` |
| `organize-uncategorized` | Find feeds with no folder and suggest assignments | -- |
| `summarize-recent` | Digest recent articles grouped by source with key themes | `folder?`, `hours?` |
| `review-saved-web-pages` | Review saved pages, decide which to keep or remove | -- |
| `analyze-classifier` | Build a reliability diagram for the Inoreader Intelligence classifier from verified-tagged articles | `breakdown_by?`, `bins?` |

## Classifier calibration workflow

If you use Inoreader Intelligence to classify articles as worth reading vs. skippable, the calibration tools let you treat that LLM as a binary classifier and analyze its reliability over time using only data already in Inoreader (no new LLM calls).

### 1. Configure the prompt

In Inoreader Intelligence settings, create a custom summary prompt:

```
Summarize this article in 2-3 sentences. Then on new lines, output exactly:

RECOMMENDATION: read | skip
CONFIDENCE: <integer 0-100>

Be conservative — most articles are not worth reading in full. Recommend "read"
only if the article likely contains substantive new information that cannot be
obtained from the summary alone.
```

Optionally set up an Inoreader automation rule with the "Create summary" action so summaries are auto-generated for new articles in folders you care about.

### 2. Tag articles after reading

When you finish reading an article, apply one of these tags via `manage_tags` (forward slashes are part of the label name, not a folder hierarchy):

| Tag | Meaning |
|-----|---------|
| `read/worth-it` | Opened a recommend-read article, was worth it (true positive) |
| `read/not-worth-it` | Opened a recommend-read article, wasn't worth it (false positive) |
| `audit/worth-it` | Opened a recommend-skip article as an audit, was worth it (false negative caught) |
| `audit/not-worth-it` | Opened a recommend-skip article as an audit, wasn't worth it (true negative confirmed) |

### 3. Run the analysis

Call the `analyze-classifier` prompt periodically (or once verified counts pass ~30).
It runs `analyze_classifier_calibration` once, checks `data_summary` for sufficient
labels and cap flags, then reviews the reliability diagram and diagnostics. It does
not repeat the same extraction merely to inventory labels.

### 4. Optionally audit

If you want to validate that the calibration curve extends below the decision threshold, call `recommend_audit_articles`. It returns a small batch of recommend-skip articles weighted by where the calibration curve has the most uncertainty. Read them, apply the `audit/*` tags, and the next `analyze_classifier_calibration` run will produce a posterior over recall using that data.

### Why this is structured this way

This is a *selective labels* problem: you observe ground truth for articles the LLM recommended (you read them), and not for articles it told you to skip (unless you audit). The calibration curve **on the recommended slice is fully identified** from observed data — that's the headline product, with per-bin Beta-Binomial posteriors and an isotonically-smoothed monotone curve. Below the decision threshold, behavior is unobserved without audits; that's why the threshold diagnostic only states an upper bound (via monotonicity) and the recall posterior only appears once `audit/*` tags exist.

## Write verification

Every bulk write reads its own result back and reports only what the server confirms.

This exists because of a specific failure. A 42-feed `reassign_feeds` call returned
`{"succeeded": 42, "failed": 0}` having actually moved 21: eleven feeds had not moved,
and fourteen had been added to the destination without being removed from the source —
from a single request carrying both `a=` and `r=` that Inoreader answered `200`. The
discrepancy surfaced days later, by reading all 1818 subscriptions back by hand.

Two things allowed it. `succeeded` counted HTTP 2xx responses rather than applied
changes, and `by_folder` was built from the *input* map, so it could not represent a
shortfall at all. Inoreader also returns `200 "OK"` for an edit to a feed that does not
exist, so no amount of inspecting the request or its response can establish what
happened. Only reading the state back can.

So the bulk tools preflight known worst-case write/verification costs, apply, wait,
re-read, reconcile observed shortfalls once, and report. Missing articles/feeds or
failed verification are unknown, not permission to replay an ambiguous write:

| Field | Meaning |
|---|---|
| `verified` | Confirmed present on the server |
| `unverified` | The write returned 2xx but the server does not show the change |
| `failed` | The write itself errored |
| `not_attempted` | Skipped, e.g. budget |

`isError` is set whenever `verified < intended`. **Trust `verified`, never the size of
your request.** `unverified` is the bucket the old code reported as success.

Verification is cheap for folder writes — `subscription/list` returns every feed with
its labels in one request, so 4 feeds and 400 cost the same, in the zone that is not
scarce. Article tags cost one read per 50.

## Rate Limits

Tool descriptions and the static guide include API costs. `get_rate_limit_status`
and `inoreader://rate-limits` make **zero HTTP requests or auth probes**, reading
persisted observations under `~/.config/inoreader-mcp/rate-limit.json`.

Every API fetch attempt, including retries and transport failures, is counted; every
response's quota headers are ingested, including 429/5xx. Usage/limit observations
are timestamped per zone. Raw headers are distinct from conservative admission
estimates for later local attempts or out-of-order responses. Reset/cooldown times
are absolute and countdowns age. Missing/expired usage is **unknown**, not free calls;
legacy snapshots without field-level provenance do not authorize quota estimates.
Other clients/processes may consume unseen quota. Persistence is best-effort telemetry,
not a cross-process lock; admission and the shared four-operation HTTP concurrency
cap apply within one process (including public-site discovery and OAuth).

Safe reads alone retry up to four attempts, with jitter and Retry-After; delays over
60 seconds fail with a persisted cooldown instead of sleeping indefinitely. Writes
are never blindly replayed after transport loss, 5xx or unexpected bodies. OAuth
requests and public-site fetches are separate from Zone 1/2 API counts.

Expensive workflows preflight known headroom and recheck admission on each attempt.
`analyze_feeds` defaults to at most 100 base calls across tags/volume (`max_requests`
up to 500); it and classifier scans leave 25 known requests in reserve. Classifier
scans preflight the maximum page budget. Unknown quota still permits bounded work.
Preflight is not a reservation: other calls can consume budget before a workflow
finishes. Partial results/cap/degraded/error flags must not be treated as full coverage.

Offline checks (no account calls): `npm test`, `npm run typecheck`, `npm run build`.
CI and the release image job require these checks.

Do not hardcode a daily limit. This README claimed ~100/zone/day for a long time; the
account it was developed against actually reports 2000. Ask the tool.

## License

MIT
