# Quantisnow SEC EDGAR MCP server and CLI

<!-- mcp-name: io.github.quantisnow/sec-edgar-mcp -->

A hosted MCP server for SEC EDGAR data. Claude, ChatGPT, Cursor, VS Code and other MCP clients can search every SEC filing by what it says, look up Form 4 insider trades, 13F holdings, 13D/13G stakes, 8-K events by item, XBRL financial statements and House members' stock trades. The same data works from your terminal with `npx quantisnow`.

There is nothing to run or host: the server lives at

```
https://www.quantisnow.com/api/v1/mcp
```

and signs you in through your MCP client's own browser flow (OAuth), or takes an API key.

## Add it to your AI tool

Claude Code:

```bash
claude mcp add --transport http quantisnow https://www.quantisnow.com/api/v1/mcp
```

Claude.ai and Claude Desktop: Settings, Connectors, Add custom connector, and paste the URL above.

Any client that takes a JSON config (Cursor, VS Code, Windsurf):

```json
{
  "mcpServers": {
    "quantisnow": {
      "url": "https://www.quantisnow.com/api/v1/mcp"
    }
  }
}
```

Or let the CLI write the config for you. It keeps whatever else is in the file and saves the old one next to it as `.bak`:

```bash
npx quantisnow mcp install claude-code
npx quantisnow mcp install claude-desktop
npx quantisnow mcp install cursor
npx quantisnow mcp install vscode
npx quantisnow mcp install windsurf
npx quantisnow mcp install codex
npx quantisnow mcp install gemini
```

Add `--print` to see the change without writing it. For clients that only start local commands, `npx quantisnow mcp` runs a stdio server that forwards to the hosted one.

New accounts get 20 free calls. Plans start at $49 a month: [pricing](https://www.quantisnow.com/sec-api#plans).

## Tools

| Tool | What it does |
| --- | --- |
| `search` | Query a dataset with Lucene-style syntax: `ticker:NVDA AND formType:4`, ranges like `filedAt:[2026-01-01 TO 2026-03-31]`, comparisons like `field:>1000000`. |
| `full_text_search` | Words and "quoted phrases" inside filing text and exhibits, with the same field filters. |
| `describe_dataset` | The fields, types and example queries for one dataset. |

Datasets: SEC filings (all form types), Form 3/4/5 and 144 insider trades, 8-K events by item, 13D/13G beneficial ownership, 13F holdings, XBRL financial statements, and House members' periodic transaction reports. Every result links to its Quantisnow page and the filing on sec.gov.

Things people ask it:

- Which insiders bought more than $1M of their own stock this week?
- Find 10-Ks from the last year that raise substantial doubt about going concern, and list the tickers.
- Which companies changed auditors (8-K Item 4.01) in the last 90 days?
- What did Berkshire Hathaway add and sell in its latest 13F?
- Show Apple's quarterly revenue and free cash flow for the last eight quarters.

## Command line

```bash
npx quantisnow login
npx quantisnow search '"substantial doubt" "going concern"' --forms 10-K,10-Q
```

`login` opens your browser to sign in.

```bash
# Words and phrases inside filings and their exhibits
npx quantisnow search '"material weakness" ticker:SMCI'
npx quantisnow search '"reverse stock split"' --forms 8-K --newest

# Ask in plain English; it writes the query and shows it
npx quantisnow ask "which directors bought more than $500K of their own stock this month"

# Insider trades
npx quantisnow insiders --min 1m            # open-market buys over $1M, last 30 days
npx quantisnow insiders NVDA --sells --days 90

# 8-K events by item
npx quantisnow events officers              # Item 5.02: officer and director changes
npx quantisnow events auditor --days 365    # Item 4.01: auditor changes
npx quantisnow events 1.03                  # bankruptcy

# 13F, financials, congress
npx quantisnow holders AAPL --change new    # funds that opened a position last quarter
npx quantisnow financials MSFT --annual
npx quantisnow congress NVDA

# Anything else, in the query syntax
npx quantisnow query 13f/holdings "manager.cik:0001067983 AND period:2026-09-30" --sort valueUsd:desc
```

Add `--json` to any command to get the raw response for `jq`, `-n 50` for more rows, and `--show-query` on the shortcut commands to see the query they send.

## Keys and limits

`npx quantisnow usage` shows your plan, the calls left and your credits; it doesn't count as a call. Every search, `ask` and MCP tool call is one call. When the calls run out the API answers `429` instead of charging for more.

Prefer an API key over the browser sign-in (for CI, servers, scripts)? Make one at [quantisnow.com/sec-api/keys](https://www.quantisnow.com/sec-api/keys), then either:

```bash
npx quantisnow login --key qs_...
export QUANTISNOW_API_KEY=qs_...
```

MCP clients that send headers can pass it as `Authorization: Bearer qs_...`.

The sign-in or key is saved to `~/.config/quantisnow/config.json` with permissions 600. `npx quantisnow logout` removes it.

## REST API and docs

The same datasets are a REST API at `https://www.quantisnow.com/api/v1`. API reference, query syntax, one page per SEC form and guides: [quantisnow.com/sec-api](https://www.quantisnow.com/sec-api). MCP setup for each client: [quantisnow.com/sec-api/mcp](https://www.quantisnow.com/sec-api/mcp). Every docs page also has a Markdown version at the same URL plus `.md`.

Quantisnow is not affiliated with or endorsed by the U.S. Securities and Exchange Commission. EDGAR is the SEC's filing system; the filings themselves are public records.

## Releases

Every push to `main` publishes a new version to npm and the MCP registry from GitHub Actions. `package.json` and `server.json` carry the major and minor version; the patch number is the workflow run number.

MIT license.
