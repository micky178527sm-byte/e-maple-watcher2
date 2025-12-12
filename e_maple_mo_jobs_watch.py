import os, json, re, sys, subprocess, warnings
from pathlib import Path

warnings.filterwarnings("ignore", message=r"urllib3 v2 only supports OpenSSL.*")

import requests
from bs4 import BeautifulSoup

WATCH_URL = "http://www.e-maple.net/classified.html?cat=WO&area=MO"
OPEN_URL  = "http://www.e-maple.net/classified.html?cat=WO&area=MO"

STATE_FILE = Path(__file__).with_name("e_maple_state.json")
TOKEN_FILE = Path.home() / ".emaple_line_token"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; e-maple-watcher/1.0; +local-script)"}

def load_last_no() -> int:
    if STATE_FILE.exists():
        try:
            return int(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("last_no", 0))
        except Exception:
            return 0
    return 0

def save_last_no(n: int) -> None:
    STATE_FILE.write_text(json.dumps({"last_no": n}, ensure_ascii=False), encoding="utf-8")

def fetch_item_nos():
    r = requests.get(WATCH_URL, headers=HEADERS, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    nos = []
    for a in soup.select("a[href*='classified/item.html?no=']"):
        href = a.get("href", "")
        m = re.search(r"no=(\d+)", href)
        if m:
            nos.append(int(m.group(1)))
    return sorted(set(nos), reverse=True)

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
    items = fetch_item_nos()
    if not items:
        return

    newest_no = items[0]

    if "--init" in args:
        save_last_no(newest_no)
        return

    last_no = load_last_no()
    new_count = sum(1 for no in items if no > last_no)

    if new_count > 0:
        msg = f"e-Maple（モントリオール求人）に新着 {new_count} 件：{OPEN_URL}"
        send_line_message(msg)
        save_last_no(newest_no)

if __name__ == "__main__":
    main()
