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

## Tools

### Reading

| Tool | Description | API Cost |
|------|-------------|----------|
| `get_unread_counts` | Unread counts for all feeds/folders, sorted by count | 1 Z1 |
| `get_articles` | Fetch articles with filters (stream, status, date range, pagination) | 1 Z1/page |
| `get_article_ids` | Lightweight ID-only fetch for counting/batch ops | 1 Z1 |

### Subscriptions

| Tool | Description | API Cost |
|------|-------------|----------|
| `list_subscriptions` | All feeds with folders, URLs, metadata | 1 Z1 |
| `manage_subscription` | Subscribe, edit (rename/move), or unsubscribe | 1 Z2 |

### Organization

| Tool | Description | API Cost |
|------|-------------|----------|
| `manage_tags` | Mark read/unread/starred, apply/remove tags (batch support) | 1 Z2 |
| `mark_all_read` | Mark all items in a feed/folder as read | 1 Z2 |
| `list_folders_and_tags` | All folders and tags with unread counts | 1 Z1 |

### Analytics

| Tool | Description | API Cost |
|------|-------------|----------|
| `analyze_feeds` | Feed health analysis -- flags high-noise and dormant feeds | 2 Z1 |
| `get_rate_limit_status` | Check remaining API budget (uses cached headers) | 0 |
| `get_user_info` | Authenticated user info | 1 Z1 |

**Z1** = Zone 1 (read), **Z2** = Zone 2 (write). Inoreader enforces ~100 requests/day per zone.

## Rate Limits

Every tool description includes its API cost so Claude can budget calls. The `get_rate_limit_status` tool returns current usage without making any API requests. Inoreader's free tier allows ~100 requests per day per zone.

## License

MIT
