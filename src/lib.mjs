// Pure helpers for the quantisnow CLI: argument parsing, query building,
// output formatting, SSE parsing and MCP client configs. No I/O here, so
// everything is covered by test/lib.test.mjs.

export const SITE = "https://www.quantisnow.com";
export const API = `${SITE}/api/v1`;
export const MCP_URL = `${API}/mcp`;
export const KEYS_URL = `${SITE}/sec-api/keys`;
export const KEY_RE = /^qs_[0-9A-Za-z]{40}$/;

export const DATASETS = [
  { path: "filings", about: "Every EDGAR filing: form type, company, items, links" },
  { path: "8-k/events", about: "8-K items one per row: officer changes, auditor changes, bankruptcies" },
  { path: "insider-trades", about: "Forms 3, 4, 5 and 144: who bought or sold, how much, at what value" },
  { path: "ownership", about: "13D and 13G stakes of 5% or more" },
  { path: "13f/holdings", about: "13F positions per manager and quarter, with change since last quarter" },
  { path: "financials", about: "Income statement, balance sheet and cash flow from XBRL" },
  { path: "congress/trades", about: "House members' stock trades from periodic transaction reports" },
];

// ---- Arguments ----

// --flag value, --flag=value, -n 5, bare --switch, and positionals.
// Flags listed in `bools` never take a value.
export function parseArgs(argv, bools = []) {
  const flags = {};
  const pos = [];
  const short = { n: "size", j: "json", h: "help", k: "key" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    const m = a.match(/^--?([A-Za-z][\w-]*)(?:=(.*))?$/);
    if (!m || /^-\d/.test(a)) {
      pos.push(a);
      continue;
    }
    const name = (a.startsWith("--") ? m[1] : short[m[1]] ?? m[1]).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[2] !== undefined) flags[name] = m[2];
    else if (bools.includes(name) || i + 1 >= argv.length || argv[i + 1].startsWith("-")) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { flags, pos };
}

export function intFlag(v, def, min = 1, max = 1_000_000_000) {
  if (v === undefined || v === true) return def;
  const n = Number(String(v).replace(/[,_]/g, "").replace(/k$/i, "000").replace(/m$/i, "000000"));
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${v}".`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---- Dates ----

export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(days, now = new Date()) {
  return isoDay(new Date(now.getTime() - days * 86_400_000));
}

export function range(field, days, now = new Date()) {
  return `${field}:[${daysAgo(days, now)} TO ${isoDay(now)}]`;
}

// The last quarter end with 13F filings in: filings are due 45 days after.
export function last13fPeriod(now = new Date()) {
  const ends = [];
  for (let y = now.getUTCFullYear(); y >= now.getUTCFullYear() - 1; y--) {
    for (const md of ["12-31", "09-30", "06-30", "03-31"]) ends.push(`${y}-${md}`);
  }
  const cutoff = now.getTime() - 46 * 86_400_000;
  return ends.find((e) => new Date(`${e}T00:00:00Z`).getTime() <= cutoff);
}

// ---- Query builders for the shortcut commands ----

const and = (parts) => parts.filter(Boolean).join(" AND ");
const ticker = (t) => (t ? String(t).toUpperCase().replace(/[^A-Z0-9.\-]/g, "") : "");

export function insidersQuery({ symbol, side = "buys", min = 0, days = 30, form = "4" }, now = new Date()) {
  const t = ticker(symbol);
  const value = side === "sells" ? "sold.valueUsd" : "purchased.valueUsd";
  const code = side === "sells" ? "transactionCodes:S" : side === "buys" ? "transactionCodes:P" : "";
  return {
    query: and([
      `formType:${form}`,
      t && `issuer.ticker:${t}`,
      code,
      side !== "all" && min > 0 ? `${value}:>${min}` : side !== "all" ? `${value}:>0` : "",
      range("filedAt", days, now),
    ]),
    sort: [{ [side !== "all" && min > 0 ? value : "filedAt"]: { order: "desc" } }],
  };
}

export function filingsQuery({ symbol, form, days = 90 }, now = new Date()) {
  const t = ticker(symbol);
  return {
    query: and([t && `ticker:${t}`, form && `formType:"${String(form).toUpperCase()}"`, range("filedAt", days, now)]),
    sort: [{ filedAt: { order: "desc" } }],
  };
}

export const EIGHT_K_ITEMS = {
  officers: "5.02",
  auditor: "4.01",
  bankruptcy: "1.03",
  delisting: "3.01",
  earnings: "2.02",
  deals: "1.01",
  acquisitions: "2.01",
  impairments: "2.06",
  restatements: "4.02",
  votes: "5.07",
  "reg-fd": "7.01",
  cyber: "1.05",
};

export function eventsQuery({ item, symbol, days = 30 }, now = new Date()) {
  const code = EIGHT_K_ITEMS[String(item ?? "").toLowerCase()] ?? item;
  if (!code || !/^\d\.\d\d$/.test(code)) {
    throw new Error(`Pick an 8-K item number like 5.02, or one of: ${Object.keys(EIGHT_K_ITEMS).join(", ")}.`);
  }
  const t = ticker(symbol);
  return {
    query: and([`items.item:"${code}"`, t && `ticker:${t}`, range("filedAt", days, now)]),
    sort: [{ filedAt: { order: "desc" } }],
  };
}

export function holdersQuery({ symbol, change, period }, now = new Date()) {
  const t = ticker(symbol);
  if (!t) throw new Error("Which stock? For example: quantisnow holders NVDA");
  return {
    query: and([`issuer.ticker:${t}`, change && `change:${change}`, `period:${period ?? last13fPeriod(now)}`]),
    sort: [{ valueUsd: { order: "desc" } }],
  };
}

export function financialsQuery({ symbol, annual }) {
  const t = ticker(symbol);
  if (!t) throw new Error("Which company? For example: quantisnow financials AAPL");
  return {
    query: and([`ticker:${t}`, annual ? "fiscalPeriod:FY" : "fiscalPeriod:(Q1 OR Q2 OR Q3 OR Q4)"]),
    sort: [{ periodEnd: { order: "desc" } }],
  };
}

export function congressQuery({ symbol, days = 90, min = 0 }, now = new Date()) {
  const t = ticker(symbol);
  return {
    query: and([t && `ticker:${t}`, min > 0 && `amount.min:>=${min}`, range("tradedOn", days, now)]),
    sort: [{ tradedOn: { order: "desc" } }],
  };
}

// ---- Output ----

const color = (code) => (s, on) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const bold = color("1");
export const dim = color("2");
export const cyan = color("36");
export const green = color("32");
export const red = color("31");
export const yellow = color("33");

export function money(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "";
  const v = Number(n);
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${v < 0 ? "-" : ""}$${s}`;
}

export function shortDate(s) {
  return s ? String(s).slice(0, 10) : "";
}

// <em>x</em> from the highlighter becomes bold (or plain without color).
export function highlight(html, on) {
  return String(html)
    .replace(/<em>(.*?)<\/em>/g, (_, w) => (on ? `\x1b[1;33m${w}\x1b[0m` : w))
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}

// One readable line (plus an optional second) per row, whatever the dataset.
export function formatRow(r, on = false) {
  if (r.reportingOwner && r.issuer) {
    const buy = Number(r.purchased?.valueUsd ?? 0);
    const sell = Number(r.sold?.valueUsd ?? 0);
    const planned = Number(r.plannedSale?.valueUsd ?? 0);
    const what = buy > 0 ? green(`bought ${money(buy)}`, on) : sell > 0 ? red(`sold ${money(sell)}`, on) : planned > 0 ? yellow(`plans to sell ${money(planned)}`, on) : dim(`Form ${r.formType}`, on);
    const role = r.reportingOwner.officerTitle || (r.reportingOwner.isDirector ? "Director" : r.reportingOwner.isTenPercentOwner ? "10% owner" : "");
    return `${dim(shortDate(r.transactionDate || r.filedAt), on)}  ${bold(r.issuer.ticker || "-", on)}  ${clip(r.reportingOwner.name, 40)}${role ? dim(` (${clip(role, 30)})`, on) : ""}  ${what}${r.rule10b51 ? dim(" 10b5-1", on) : ""}`;
  }
  if (r.manager && r.issuer) {
    const ch = r.change ? ` ${r.change === "new" ? green("new", on) : r.change === "sold" ? red("sold out", on) : r.change}` : "";
    return `${dim(r.period, on)}  ${bold(r.issuer.ticker || "-", on)}  ${clip(r.manager.name, 44)}  ${money(r.valueUsd)}${ch}`;
  }
  if (r.filer && r.subject) {
    return `${dim(shortDate(r.filedAt), on)}  ${bold(r.subject.ticker || "-", on)}  ${r.formType}  ${clip(r.filer.name, 40)} in ${clip(r.subject.name, 40)}`;
  }
  if (r.member) {
    const amt = r.amount ? `${money(r.amount.min)}${r.amount.max ? `-${money(r.amount.max)}` : "+"}` : "";
    return `${dim(shortDate(r.tradedOn), on)}  ${bold(r.ticker || "-", on)}  ${r.member.name} (${r.member.party}-${r.member.state})  ${String(r.type).replace(/_/g, " ")} ${amt}`;
  }
  if (r.incomeStatement) {
    const is = r.incomeStatement;
    const cf = r.cashFlow ?? {};
    return `${dim(`${r.fiscalYear} ${r.fiscalPeriod}`, on)}  ${bold(r.ticker || "-", on)}  revenue ${money(is.revenue)}  net income ${money(is.netIncome)}${cf.freeCashFlow !== undefined ? `  FCF ${money(cf.freeCashFlow)}` : ""}`;
  }
  const items = Array.isArray(r.items) && r.items.length ? `  ${dim(r.items.map((i) => (typeof i === "string" ? i : i.item)).join(", "), on)}` : "";
  const line = `${dim(shortDate(r.filedAt), on)}  ${bold(r.ticker || "-", on)}  ${cyan(r.formType ?? r.kind ?? "", on)}  ${clip(r.companyName ?? r.title ?? "", 50)}${items}`;
  const about = r.highlights?.length ? highlight(r.highlights[0], on) : r.description ? clip(r.description, 160) : "";
  return about ? `${line}\n    ${clip(about, 220)}` : line;
}

export function link(r) {
  return r.quantisnowUrl || r.linkToFilingIndex || r.linkToFilingDetails || "";
}

export function formatResults(out, { color: on = false, links = true } = {}) {
  const data = out?.data ?? [];
  const total = out?.total?.value ?? data.length;
  if (data.length === 0) return dim("No results. Widen the date range with --days, or loosen the query.", on);
  const lines = data.map((r) => {
    const l = links ? link(r) : "";
    return `${formatRow(r, on)}${l ? `\n    ${dim(l, on)}` : ""}`;
  });
  const more = total > data.length ? dim(`\n${data.length} of ${total.toLocaleString("en-US")}${out?.total?.relation === "gte" ? "+" : ""}. More with -n 50, or --json for everything.`, on) : "";
  return lines.join("\n") + more;
}

// ---- MCP ----

// A Streamable HTTP response body is either JSON or SSE; returns the JSON-RPC
// messages in it.
export function parseMcpBody(contentType, body) {
  if (!body || !body.trim()) return [];
  if (/text\/event-stream/i.test(contentType ?? "")) {
    const out = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) {
        try {
          out.push(JSON.parse(data));
        } catch {
          /* keep-alive or partial */
        }
      }
    }
    return out;
  }
  const v = JSON.parse(body);
  return Array.isArray(v) ? v : [v];
}

export const MCP_CLIENTS = ["claude-desktop", "claude-code", "cursor", "vscode", "windsurf", "codex", "gemini"];

// Without a key the client gets the bare URL and runs the OAuth sign-in itself.
const auth = (key) => (key ? { headers: { Authorization: `Bearer ${key}` } } : {});

// The server entry for clients that speak remote HTTP.
export function httpEntry(key) {
  return { type: "http", url: MCP_URL, ...auth(key) };
}

// The server entry for clients that only start local commands. Without a key
// the bridge uses the CLI's saved sign-in.
export function stdioEntry(key) {
  return { command: "npx", args: ["-y", "quantisnow", "mcp"], ...(key ? { env: { QUANTISNOW_API_KEY: key } } : {}) };
}

// Where each client keeps its MCP config, relative to home (and APPDATA on Windows).
export function configPath(client, { platform = process.platform, home = "", appData = "" } = {}) {
  const join = (...p) => p.join(platform === "win32" ? "\\" : "/");
  switch (client) {
    case "claude-desktop":
      if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(appData, "Claude", "claude_desktop_config.json");
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "gemini":
      return join(home, ".gemini", "settings.json");
    default:
      return null;
  }
}

// Adds (or replaces) the quantisnow server in a client's config object.
export function mergeConfig(client, existing, key) {
  const cfg = existing && typeof existing === "object" ? structuredClone(existing) : {};
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
  if (client === "claude-desktop") cfg.mcpServers.quantisnow = stdioEntry(key);
  else if (client === "windsurf") cfg.mcpServers.quantisnow = { serverUrl: MCP_URL, ...auth(key) };
  else if (client === "gemini") cfg.mcpServers.quantisnow = { httpUrl: MCP_URL, ...auth(key) };
  else cfg.mcpServers.quantisnow = { url: MCP_URL, ...auth(key) };
  return cfg;
}

export function maskKey(key) {
  return key ? `${key.slice(0, 7)}...${key.slice(-4)}` : "";
}
