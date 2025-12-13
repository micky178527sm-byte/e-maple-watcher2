import os, json, re, sys, subprocess, warnings
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional

warnings.filterwarnings("ignore", message=r"urllib3 v2 only supports OpenSSL.*")

import requests
from bs4 import BeautifulSoup

WATCH_URL = "http://www.e-maple.net/classified.html?cat=WO&area=MO"
OPEN_URL  = "http://www.e-maple.net/classified.html?cat=WO&area=MO"

STATE_FILE = Path(__file__).with_name("e_maple_state.json")
TOKEN_FILE = Path.home() / ".emaple_line_token"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; e-maple-watcher/1.0; +local-script)"}

from typing import Optional
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
ET  = ZoneInfo("America/Toronto")
DT_RE = re.compile(r"\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b")  # 分まで

def parse_updated_dt(text: str) -> Optional[str]:
    m = DT_RE.search(text)
    return m.group(0) if m else None

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_state(st: dict) -> None:
    STATE_FILE.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")

def get_last_dt_and_seen():
    st = load_state()
    last_dt = st.get("last_dt")  # "YYYY-MM-DD HH:MM"
    seen = set(st.get("seen_nos", []))
    return last_dt, seen

def set_last_dt_and_seen(last_dt: str, seen_nos: list) -> None:
    save_state({"last_dt": last_dt, "seen_nos": seen_nos})

def fetch_items():
    r = requests.get(WATCH_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    items = []
    for a in soup.select("a[href*='classified/item.html?no=']"):
        href = a.get("href", "")
        m = re.search(r"no=(\d+)", href)
        if not m:
            continue
        no = int(m.group(1))

        container = a.find_parent(["tr", "li", "div", "p"]) or a.parent
        text = container.get_text(" ", strip=True) if container else a.get_text(" ", strip=True)

        dt = parse_updated_dt(text)  # "YYYY-MM-DD HH:MM"
        if not dt:
            continue

        items.append({"no": no, "dt": dt, "text": text})

    # dt降順（文字列のままでも "YYYY-MM-DD HH:MM" なので並び順が合う）
    items.sort(key=lambda x: (x["dt"], x["no"]), reverse=True)
    return items

def read_token() -> str:
    t = os.environ.get("CHANNEL_ACCESS_TOKEN", "")
    if t:
        return t
    # ↓ここから下は、今までの「ファイルから読む処理」があれば残す（なければ消してOK）
    with open("token.txt", "r", encoding="utf-8") as f:
        return f.read().strip()

def send_line_message(text: str) -> None:
    token = read_token()
    url = "https://api.line.me/v2/bot/message/broadcast"
    payload = {"messages": [{"type": "text", "text": text}]}
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=payload,
        timeout=20,
    )
    r.raise_for_status()

def main():
    args = set(sys.argv[1:])
    items = fetch_items()
    if not items:
        return

    newest_dt = items[0]["dt"]             # "YYYY-MM-DD HH:MM"
    same_dt_nos = [x["no"] for x in items if x["dt"] == newest_dt]

    # 初回は通知なしで基準だけ作る（大量通知防止）
    if "--init" in args:
        set_last_dt_and_seen(newest_dt, same_dt_nos)
        return

    last_dt, seen = get_last_dt_and_seen()
    if not last_dt:
        # stateが無い/旧形式なら通知せず基準作成
        set_last_dt_and_seen(newest_dt, same_dt_nos)
        return

    new_or_updated = []
    for x in items:
        if x["dt"] > last_dt:
            new_or_updated.append(x)
        elif x["dt"] == last_dt and x["no"] not in seen:
            new_or_updated.append(x)

    if new_or_updated:
        msg = f"e-Maple（MO求人）新規/更新 {len(new_or_updated)} 件：{OPEN_URL}"
        send_line_message(msg)
        set_last_dt_and_seen(newest_dt, same_dt_nos)

if __name__ == "__main__":
    main()
