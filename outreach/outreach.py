#!/usr/bin/env python3
"""Individually tailored outreach: dry-run by default, verified contacts only,
suppression list, send log, one follow-up, small daily batches.

  python3 outreach.py send               # dry run, prints what would go out
  python3 outreach.py send --live        # actually sends (needs config.json)
  python3 outreach.py followups [--live]
  python3 outreach.py optout someone@x.gov.in
  python3 outreach.py status
"""
import argparse, csv, json, os, smtplib, sys, time
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).parent
CONTACTS, LOG, SUPPRESS = HERE/"contacts.csv", HERE/"send_log.csv", HERE/"suppression.txt"
LOG_FIELDS = ["timestamp", "email", "department", "kind", "status"]
TOPICS = {"photosynthesis": "Photosynthesis (school science)", "banking_interest": "Simple vs compound interest",
          "skilling_electrician": "Electrician basics", "govt_exams_percentage": "Percentage shortcuts for competitive exams",
          "engine_3d_explained": "How a petrol engine works (3D)"}

def suppressed():
    return {l.strip().lower() for l in SUPPRESS.read_text().splitlines() if l.strip()} if SUPPRESS.exists() else set()

def read_log():
    if not LOG.exists(): return []
    with LOG.open() as f: return list(csv.DictReader(f))

def append_log(row):
    new = not LOG.exists()
    with LOG.open("a", newline="") as f:
        w = csv.DictWriter(f, LOG_FIELDS)
        if new: w.writeheader()
        w.writerow(row)

def eligible(c):
    """A contact is mailable only if verified on an official page and has every field the email needs."""
    if c["verified"].strip().lower() != "yes": return "not verified"
    if not c["source_url"].strip(): return "no source_url"
    if "@" not in c["email"] or not c["person"].strip() or not c["video_url"].strip(): return "incomplete row"
    if c["email"].strip().lower() in suppressed(): return "opted out"
    return None

def build(c, cfg, kind, first_sent=""):
    tpl = (HERE/"templates"/("first_touch.txt" if kind == "first" else "follow_up.txt")).read_text()
    fields = dict(cfg, department=c["department"], topic=TOPICS.get(c["demo_video"], c["demo_video"]),
                  video_url=c["video_url"], salutation=f'{c["designation"]} {c["person"]}'.strip(), first_sent=first_sent)
    subject, body = tpl.format(**fields).split("\n", 1)
    msg = EmailMessage()
    msg["Subject"] = subject.removeprefix("Subject: ")
    msg["From"] = f'{cfg["sender_name"]} <{cfg["smtp_user"]}>'
    msg["To"] = c["email"]
    msg["List-Unsubscribe"] = f'<{cfg["optout_url"]}>'
    msg.set_content(body.lstrip("\n"))
    return msg

def run(kind, live):
    cfg = json.loads((HERE/"config.json").read_text()) if (HERE/"config.json").exists() else json.loads((HERE/"config.example.json").read_text())
    if live and not (HERE/"config.json").exists(): sys.exit("config.json missing")
    log = read_log()
    today_sent = sum(1 for r in log if r["timestamp"].startswith(date.today().isoformat()) and r["status"] == "sent")
    budget = cfg["daily_limit"] - today_sent
    firsts = {r["email"]: r["timestamp"] for r in log if r["kind"] == "first" and r["status"] == "sent"}
    follows = [r["email"] for r in log if r["kind"] == "followup" and r["status"] == "sent"]
    server = None
    if live:
        server = smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"]); server.starttls()
        server.login(cfg["smtp_user"], os.environ[cfg["smtp_password_env"]])
    with CONTACTS.open() as f:
        for c in csv.DictReader(f):
            email = c["email"].strip().lower()
            if kind == "first" and email in firsts: continue
            if kind == "followup":
                if email not in firsts or follows.count(email) >= cfg["max_followups"]: continue
                sent = datetime.fromisoformat(firsts[email])
                if datetime.now() - sent < timedelta(days=cfg["followup_after_days"]): continue
            why = eligible(c)
            if why:
                print(f'SKIP {c["department"]}: {why}'); continue
            if budget <= 0: print("daily limit reached"); break
            msg = build(c, cfg, kind, firsts.get(email, "")[:10])
            if live:
                server.send_message(msg); time.sleep(20)
            else:
                print(f'--- DRY RUN to {email}\n{msg}')
            append_log({"timestamp": datetime.now().isoformat(timespec="seconds"), "email": email,
                        "department": c["department"], "kind": kind, "status": "sent" if live else "dryrun"}) if live else None
            budget -= 1
    if server: server.quit()

def main():
    p = argparse.ArgumentParser(); s = p.add_subparsers(dest="cmd", required=True)
    for n in ("send", "followups"): s.add_parser(n).add_argument("--live", action="store_true")
    s.add_parser("optout").add_argument("email"); s.add_parser("status")
    a = p.parse_args()
    if a.cmd == "send": run("first", a.live)
    elif a.cmd == "followups": run("followup", a.live)
    elif a.cmd == "optout":
        with SUPPRESS.open("a") as f: f.write(a.email.strip().lower() + "\n")
        print("added to suppression list")
    else:
        rows = read_log(); print(f"{len(rows)} log rows; sent: {sum(r['status']=='sent' for r in rows)}")
if __name__ == "__main__": main()
