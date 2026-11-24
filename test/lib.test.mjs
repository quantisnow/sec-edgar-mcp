import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_URL,
  configPath,
  eventsQuery,
  filingsQuery,
  formatResults,
  formatRow,
  highlight,
  holdersQuery,
  insidersQuery,
  intFlag,
  last13fPeriod,
  mergeConfig,
  money,
  parseArgs,
  parseMcpBody,
  stdioEntry,
} from "../src/lib.mjs";

const NOW = new Date("2026-11-23T18:00:00Z");

test("parses flags, short flags, booleans and positionals", () => {
  const { flags, pos } = parseArgs(["going", "concern", "--forms", "10-K,10-Q", "-n", "5", "--json", "--min=1m", "--no-links"], ["json", "noLinks"]);
  assert.deepEqual(pos, ["going", "concern"]);
  assert.equal(flags.forms, "10-K,10-Q");
  assert.equal(flags.size, "5");
  assert.equal(flags.json, true);
  assert.equal(flags.min, "1m");
  assert.equal(flags.noLinks, true);
});

test("a boolean flag never eats the next word", () => {
  const { flags, pos } = parseArgs(["--sells", "NVDA"], ["sells"]);
  assert.equal(flags.sells, true);
  assert.deepEqual(pos, ["NVDA"]);
});

test("numbers take k and m suffixes and clamp", () => {
  assert.equal(intFlag("1m", 0), 1_000_000);
  assert.equal(intFlag("250k", 0), 250_000);
  assert.equal(intFlag("500", 10, 1, 50), 50);
  assert.equal(intFlag(undefined, 10), 10);
  assert.throws(() => intFlag("lots", 10));
});

test("insider buys over a value sort by value", () => {
  const q = insidersQuery({ symbol: "nvda", side: "buys", min: 1_000_000, days: 30 }, NOW);
  assert.equal(q.query, "formType:4 AND issuer.ticker:NVDA AND transactionCodes:P AND purchased.valueUsd:>1000000 AND filedAt:[2026-10-24 TO 2026-11-23]");
  assert.deepEqual(q.sort, [{ "purchased.valueUsd": { order: "desc" } }]);
});

test("insider sells and all", () => {
  assert.match(insidersQuery({ side: "sells", days: 7 }, NOW).query, /transactionCodes:S AND sold\.valueUsd:>0/);
  const all = insidersQuery({ symbol: "AAPL", side: "all", days: 7 }, NOW);
  assert.equal(all.query, "formType:4 AND issuer.ticker:AAPL AND filedAt:[2026-11-16 TO 2026-11-23]");
});

test("filings and 8-K events", () => {
  assert.equal(filingsQuery({ symbol: "TSLA", form: "8-k", days: 30 }, NOW).query, 'ticker:TSLA AND formType:"8-K" AND filedAt:[2026-10-24 TO 2026-11-23]');
  assert.equal(eventsQuery({ item: "officers", days: 7 }, NOW).query, 'items.item:"5.02" AND filedAt:[2026-11-16 TO 2026-11-23]');
  assert.equal(eventsQuery({ item: "1.03", symbol: "ABC", days: 7 }, NOW).query, 'items.item:"1.03" AND ticker:ABC AND filedAt:[2026-11-16 TO 2026-11-23]');
  assert.throws(() => eventsQuery({ item: "weather" }, NOW));
});

test("13F uses the last quarter with filings in", () => {
  assert.equal(last13fPeriod(NOW), "2026-09-30");
  assert.equal(last13fPeriod(new Date("2026-11-10T00:00:00Z")), "2026-06-30");
  assert.equal(last13fPeriod(new Date("2027-01-20T00:00:00Z")), "2026-09-30");
  assert.equal(holdersQuery({ symbol: "AAPL", change: "new" }, NOW).query, "issuer.ticker:AAPL AND change:new AND period:2026-09-30");
});

test("money and highlights", () => {
  assert.equal(money(51740827.48), "$51.7M");
  assert.equal(money(-2_300_000_000), "-$2.3B");
  assert.equal(money(950), "$950");
  assert.equal(highlight("a <em>going concern</em> &amp; more", false), "a going concern & more");
});

test("rows read naturally per dataset", () => {
  const insider = {
    formType: "4",
    filedAt: "2026-11-03T16:35:59-05:00",
    transactionDate: "2026-11-02",
    issuer: { name: "MGM Resorts International", ticker: "MGM" },
    reportingOwner: { name: "Meister Keith A.", officerTitle: null, isDirector: true },
    purchased: { shares: 1745592, valueUsd: 51740827.48 },
    sold: { shares: 0, valueUsd: 0 },
  };
  assert.equal(formatRow(insider), "2026-11-02  MGM  Meister Keith A. (Director)  bought $51.7M");
  const filing = { formType: "8-K", filedAt: "2026-11-17T16:20:51-05:00", ticker: "NVDA", companyName: "NVIDIA Corporation", items: ["2.02"], highlights: ["record <em>revenue</em>"] };
  assert.equal(formatRow(filing), "2026-11-17  NVDA  8-K  NVIDIA Corporation  2.02\n    record revenue");
  assert.match(formatResults({ total: { value: 0 }, data: [] }), /No results/);
  assert.match(formatResults({ total: { value: 120, relation: "eq" }, data: [filing] }), /1 of 120/);
});

test("MCP bodies come back as JSON or SSE", () => {
  assert.deepEqual(parseMcpBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}'), [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.deepEqual(parseMcpBody("text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n'), [{ jsonrpc: "2.0", id: 2, result: { ok: true } }]);
  assert.deepEqual(parseMcpBody("application/json", ""), []);
});

test("client configs keep other servers and use the right shape", () => {
  const cfg = mergeConfig("cursor", { mcpServers: { other: { url: "x" } }, theme: "dark" }, "qs_KEY");
  assert.deepEqual(cfg.mcpServers.other, { url: "x" });
  assert.equal(cfg.theme, "dark");
  assert.deepEqual(cfg.mcpServers.quantisnow, { url: MCP_URL, headers: { Authorization: "Bearer qs_KEY" } });
  assert.deepEqual(mergeConfig("cursor", {}, null).mcpServers.quantisnow, { url: MCP_URL });
  assert.deepEqual(mergeConfig("claude-desktop", {}, "qs_KEY").mcpServers.quantisnow, stdioEntry("qs_KEY"));
  assert.deepEqual(stdioEntry(null), { command: "npx", args: ["-y", "quantisnow", "mcp"] });
  assert.equal(configPath("claude-desktop", { platform: "darwin", home: "/Users/a" }), "/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(configPath("cursor", { platform: "linux", home: "/home/a" }), "/home/a/.cursor/mcp.json");
});
