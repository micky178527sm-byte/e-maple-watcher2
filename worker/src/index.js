/**
 * e-maple-watcher (Cloudflare Worker 版)
 *
 * e-Maple モントリオールの「求人」クラシファイドを定期巡回し、
 * 新着/更新があれば本文込みで Telegram に通知する。
 *
 * - 定期実行: Cron Triggers（wrangler.toml の crons）
 * - 状態保存: KV（binding 名 STATE）に {last_dt, seen_nos} を保存
 * - 通知: Telegram Bot API（secrets: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）
 *
 * 手動操作（ブラウザ/curl）:
 *   GET /            … ステータス表示
 *   GET /run         … 1回巡回（通知あり）
 *   GET /init        … 通知せず現在の最新を基準として記録
 *   GET /test        … Telegram 接続テスト通知
 *   GET /state       … 現在の保存状態を表示
 */

const LIST_URL = "http://www.e-maple.net/classified.html?cat=WO&area=MO";
const OPEN_URL = "http://www.e-maple.net/classified.html?cat=WO&area=MO";
const ITEM_URL = (no) => `http://www.e-maple.net/classified/item.html?no=${no}`;

const STATE_KEY = "state";
const MAX_DETAIL_MESSAGES = 8;

const UA = "Mozilla/5.0 (compatible; e-maple-watcher/2.0; +cloudflare-worker)";

// ── ユーティリティ ───────────────────────────────────────────────
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities((s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function escHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pick(re, html) {
  const m = re.exec(html);
  return m ? stripTags(m[1]) : "";
}

// ── 一覧ページのパース ───────────────────────────────────────────
async function fetchListItems() {
  const res = await fetch(LIST_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`list fetch failed: ${res.status}`);
  const html = await res.text();

  const items = [];
  // 各投稿は <div class="mainList"> ... </div>（次の mainList 直前まで）
  const blocks = html.split(/<div class="mainList">/).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<div class="mainList">/)[0];

    const noMatch = /item\.html\?no=(\d+)/.exec(block);
    if (!noMatch) continue;
    const no = parseInt(noMatch[1], 10);

    const timeMatch = /<span class="time">\s*([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2})/.exec(block);
    if (!timeMatch) continue;
    const dt = timeMatch[1];

    // .top 内の各 span
    const area = pick(/<span class="icn a[^"]*"[^>]*>([\s\S]*?)<\/span>/, block);
    const category = pick(/<span class="icn b[^"]*"[^>]*>([\s\S]*?)<\/span>/, block);
    const subcat = pick(/<span class="subCat">([\s\S]*?)<\/span>/, block);
    const user = pick(/<span class="user">([\s\S]*?)<\/span>/, block);
    const body = pick(/<p>([\s\S]*?)<\/p>/, block);

    items.push({ no, dt, area, category, subcat, user, body });
  }

  // dt 降順（"YYYY-MM-DD HH:MM" 文字列のまま比較できる）
  items.sort((a, b) => (a.dt === b.dt ? b.no - a.no : a.dt < b.dt ? 1 : -1));
  return items;
}

// ── 詳細ページから連絡先メールを補完（任意・失敗許容） ──────────
async function fetchContact(no) {
  try {
    const res = await fetch(ITEM_URL(no), { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const html = await res.text();
    const m = /<span class="phone">([\s\S]*?)<\/span>/.exec(html);
    return m ? stripTags(m[1]) : "";
  } catch (_) {
    return "";
  }
}

// ── 状態 ─────────────────────────────────────────────────────────
async function loadState(env) {
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return { last_dt: null, seen_nos: [] };
  try {
    const s = JSON.parse(raw);
    return { last_dt: s.last_dt || null, seen_nos: s.seen_nos || [] };
  } catch (_) {
    return { last_dt: null, seen_nos: [] };
  }
}

async function saveState(env, last_dt, seen_nos) {
  await env.STATE.put(STATE_KEY, JSON.stringify({ last_dt, seen_nos }));
}

// ── Telegram 送信 ────────────────────────────────────────────────
async function sendTelegram(env, text, disablePreview = false) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID が未設定です");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`telegram send failed: ${res.status} ${t}`);
  }
}

function buildMessage(item, contact) {
  const lines = ["📋 <b>e-Maple モントリオール求人</b>", ""];

  let body = (item.body || "").trim();
  if (body) {
    if (body.length > 1500) body = body.slice(0, 1500) + " …";
    lines.push(escHtml(body), "");
  }

  const catBits = [item.category, item.subcat].filter(Boolean);
  if (catBits.length) lines.push(`🏷 ${escHtml(catBits.join(" / "))}`);
  if (item.user) lines.push(`👤 ${escHtml(item.user)}`);
  if (contact) lines.push(`✉️ ${escHtml(contact)}`);
  if (item.dt) lines.push(`🕐 ${escHtml(item.dt)}`);
  lines.push(`🔗 <a href="${ITEM_URL(item.no)}">詳細を開く（No.${item.no}）</a>`);

  return lines.join("\n");
}

// ── 巡回本体 ─────────────────────────────────────────────────────
async function run(env, { initOnly = false } = {}) {
  const items = await fetchListItems();
  if (!items.length) return { ok: true, note: "no items parsed" };

  const newestDt = items[0].dt;
  const sameDtNos = items.filter((x) => x.dt === newestDt).map((x) => x.no);

  if (initOnly) {
    await saveState(env, newestDt, sameDtNos);
    return { ok: true, note: "baseline set", last_dt: newestDt };
  }

  const { last_dt, seen_nos } = await loadState(env);
  if (!last_dt) {
    await saveState(env, newestDt, sameDtNos);
    return { ok: true, note: "no prior state; baseline set", last_dt: newestDt };
  }
  const seen = new Set(seen_nos);

  const newOrUpdated = items.filter(
    (x) => x.dt > last_dt || (x.dt === last_dt && !seen.has(x.no))
  );
  if (!newOrUpdated.length) {
    return { ok: true, note: "no new items", last_dt };
  }

  // 古い→新しい順で送る
  let toSend = newOrUpdated.slice().reverse();
  let overflow = [];
  if (toSend.length > MAX_DETAIL_MESSAGES) {
    overflow = toSend.slice(0, toSend.length - MAX_DETAIL_MESSAGES);
    toSend = toSend.slice(toSend.length - MAX_DETAIL_MESSAGES);
  }

  for (const x of toSend) {
    const contact = await fetchContact(x.no);
    await sendTelegram(env, buildMessage(x, contact));
  }

  if (overflow.length) {
    const nos = overflow.map((x) => `No.${x.no}`).join(", ");
    await sendTelegram(
      env,
      `➕ 他に ${overflow.length} 件の新規/更新（本文省略）: ${escHtml(nos)}\n🔗 <a href="${OPEN_URL}">一覧を開く</a>`,
      true
    );
  }

  await saveState(env, newestDt, sameDtNos);
  return { ok: true, sent: toSend.length, overflow: overflow.length, last_dt: newestDt };
}

// ── エントリポイント ─────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });

    try {
      if (path === "/test") {
        await sendTelegram(env, "✅ e-maple-watcher: Telegram 接続テスト成功", true);
        return json({ ok: true, note: "test sent" });
      }
      if (path === "/init") {
        return json(await run(env, { initOnly: true }));
      }
      if (path === "/run") {
        return json(await run(env));
      }
      if (path === "/state") {
        return json(await loadState(env));
      }
      return json({
        ok: true,
        service: "e-maple-watcher",
        endpoints: ["/run", "/init", "/test", "/state"],
      });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
