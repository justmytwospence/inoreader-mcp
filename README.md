# inoreader-mcp

MCP server for the [Inoreader](https://www.inoreader.com) RSS reader API. Lets Claude help you triage articles, analyze feed health, and manage subscriptions.

## Setup

### 1. Create an Inoreader API application

Go to the [Inoreader Developer Portal](https://www.inoreader.com/developers/) and create a new application.

- Set the redirect URI to `http://localhost:3333/callback`
- Note your **Client ID** and **Client Secret**

### 2. Add to Claude Code

```bash
claude mcp add -s user \
  -e INOREADER_CLIENT_ID=your-client-id \
  -e INOREADER_CLIENT_SECRET=your-client-secret \
  inoreader -- npx inoreader-mcp
```

Or for Claude Desktop, add to your config file:

```json
{
  "mcpServers": {
    "inoreader": {
      "command": "npx",
      "args": ["inoreader-mcp"],
      "env": {
        "INOREADER_CLIENT_ID": "your-client-id",
        "INOREADER_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### 3. Authenticate

On first use, ask Claude to call the `setup_auth` tool. It will give you an OAuth URL to open in your browser. After authorizing, copy the `code` parameter from the redirect URL and pass it back. Tokens are saved to `~/.config/inoreader-mcp/tokens.json` and refresh automatically.

## Resources

Context that MCP clients can read directly without tool calls. All are cached after first fetch.

| Resource | URI | Description | API Cost |
|----------|-----|-------------|----------|
| `rate-limits` | `inoreader://rate-limits` | Current API rate limit usage and remaining budget | 0 |
| `subscriptions` | `inoreader://subscriptions` | All feeds with id, title, URL, and folder assignments | 1 Z1 |
| `folders` | `inoreader://folders` | Folder and tag structure | 1 Z1 |
| `unread-counts` | `inoreader://unread-counts` | Unread counts per feed and folder (non-zero, sorted descending) | 1 Z1 |

## Tools

### API primitives

Thin wrappers around individual Inoreader API endpoints.

#### Reading

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_unread_counts` | Unread counts for all feeds/folders, sorted by count | 1 Z1 |
| `get_articles` | Fetch articles with filters (stream, status, date range, pagination) | 1 Z1/page |
| `get_article_ids` | Lightweight ID-only fetch for counting/batch ops | 1 Z1 |
| `get_article_content` | Full HTML content for specific articles by ID | 1 Z1 |
| `search_articles` | Keyword search across all feeds | 1 Z1/page |

#### Subscriptions

| Tool | Description | API Cost |
|------|-------------|----------|
| `list_subscriptions` | All feeds with folders, URLs, metadata | 1 Z1 |
| `manage_subscription` | Subscribe, edit (rename/move), or unsubscribe | 1 Z2 |

#### Organization

| Tool | Description | API Cost |
|------|-------------|----------|
| `manage_tags` | Mark read/unread/starred, apply/remove tags (batch support) | 1 Z2 |
| `mark_all_read` | Mark all items in a feed/folder as read | 1 Z2 |
| `list_folders_and_tags` | All folders and tags with unread counts | 1 Z1 |

#### Account

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_user_info` | Authenticated user info | 1 Z1 |
| `get_rate_limit_status` | Check remaining API budget (uses cached headers) | 0 |

### Composite tools

Higher-level workflows that combine multiple API calls or add client-side logic.

#### Feed management

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_uncategorized_feeds` | Feeds with no folder, as compact tuples | 1 Z1 |
| `categorize_feeds` | Bulk-assign feeds to folders from a `{folder: [id, ...]}` map | 1 Z2/feed |
| `reassign_feeds` | Move feeds between folders in bulk | 1 Z2/feed |
| `batch_edit_subscriptions` | Add multiple feeds to folders in one call | 1 Z2/feed |
| `analyze_feeds` | Bayesian feed health analysis with category-level priors | 3+ Z1 |

#### Saved web pages

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_saved_web_pages` | List saved pages with `removable` filter (excludes starred and `keep`-tagged) | 1 Z1/page |
| `remove_saved_web_pages` | Batch-remove saved pages by ID | 1 Z2 |

The saved pages workflow supports a `keep` tag (via `manage_tags add_tag='keep'`) to protect pages from cleanup without starring them. Use `get_saved_web_pages` with `filter='removable'` to find pages that are neither starred nor kept.

**Z1** = Zone 1 (read), **Z2** = Zone 2 (write). Inoreader enforces ~100 requests/day per zone.

## Prompts

Pre-built workflows that combine resources and tools into guided tasks.

| Prompt | Description | Arguments |
|--------|-------------|-----------|
| `triage-unread` | Review unread articles, summarize each, suggest read/star/skip | `folder?`, `count?` |
| `feed-health-review` | Analyze feed engagement, identify unsubscribe candidates | `months?`, `folder?` |
| `organize-uncategorized` | Find feeds with no folder and suggest assignments | -- |
| `summarize-recent` | Digest recent articles grouped by source with key themes | `folder?`, `hours?` |
| `review-saved-web-pages` | Review saved pages, decide which to keep or remove | -- |

## Rate Limits

Every tool description includes its API cost so Claude can budget calls. The `get_rate_limit_status` tool returns current usage without making any API requests. Inoreader's free tier allows ~100 requests per day per zone.

## License

MIT
