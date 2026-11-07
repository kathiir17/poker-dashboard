#!/usr/bin/env python3
"""One-off migration: Supabase backup + Era 2 Season 1 games  ->  Firestore.

Writes:
  config/app                               { activeSeasonNumber: 2 }
  eras/era-1, eras/era-2                   { name, number }
  eras/{era}/seasons/s{n}                  { name, number, system }
  eras/{era}/seasons/s{n}/sessions/{seq}   { seq, name, date, results }
  players/{name}                           { name }

Then reads everything back and verifies it against the source files: session and
result counts, every field of every result, and PnL totals (in whole pence) per
session, per season, per era and per player. Exits non-zero on any mismatch.

Usage (from the repo folder):
  python3 migration/migrate.py --dry-run                 # check inputs only, no Firebase
  migration/.venv/bin/python migration/migrate.py        # migrate + verify
  migration/.venv/bin/python migration/migrate.py --verify-only

The admin key is read from --key (default ~/code/secrets/poker-admin-key.json).
Its contents are never printed.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

PROJECT_ID = "poker-dashboard-bf0db"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_KEY = os.path.expanduser("~/code/secrets/poker-admin-key.json")
DEFAULT_BACKUP = os.path.expanduser("~/code/backups/poker-supabase-2026-11-07.json")
DEFAULT_ERA2 = os.path.join(HERE, "era2-season1.json")
DATE_RE = re.compile(r"^[0-3][0-9]/[01][0-9]/20[0-9][0-9]$")


def fail(msg):
    print(f"\n✗ {msg}")
    sys.exit(1)


def pence(x):
    return round(x * 100)


# ── Build the target data from the source files ─────────────────────────────

def clean_session(s, seq, where):
    if not s.get("date") or not DATE_RE.match(s["date"]):
        fail(f"{where} '{s.get('name')}' has a missing or badly formatted date: {s.get('date')!r} (need DD/MM/YYYY)")
    results = []
    for r in s["results"]:
        if set(r) != {"player", "buyin", "final"}:
            fail(f"{where} '{s['name']}' has a result with unexpected fields: {sorted(r)}")
        if not isinstance(r["player"], str) or not r["player"].strip() or "/" in r["player"]:
            fail(f"{where} '{s['name']}' has a bad player name: {r['player']!r}")
        for k in ("buyin", "final"):
            if not isinstance(r[k], (int, float)) or isinstance(r[k], bool) or r[k] < 0:
                fail(f"{where} '{s['name']}' has a bad {k} for {r['player']}: {r[k]!r}")
        results.append({"player": r["player"], "buyin": r["buyin"], "final": r["final"]})
    if not 2 <= len(results) <= 20:
        fail(f"{where} '{s['name']}' has {len(results)} results (rules allow 2–20)")
    return {"seq": seq, "name": s["name"], "date": s["date"], "results": results}


def build_target(backup_path, era2_path):
    with open(backup_path) as f:
        backup = json.load(f)
    if not (isinstance(backup, list) and len(backup) == 1 and isinstance(backup[0].get("data"), list)):
        fail("Backup isn't in the expected shape: a list with one row that has a 'data' list of seasons")
    legacy = backup[0]["data"]

    with open(era2_path) as f:
        era2 = json.load(f)

    eras = {
        "era-1": {"name": "Legacy", "number": 1, "seasons": []},
        "era-2": {"name": "Era 2", "number": 2, "seasons": []},
    }
    for n, se in enumerate(legacy, 1):
        if se.get("system") not in ("old", "pnl"):
            fail(f"Legacy season {n} has unknown system {se.get('system')!r}")
        eras["era-1"]["seasons"].append({
            "id": f"s{n}", "name": se["name"], "number": n, "system": se["system"],
            "sessions": [clean_session(s, i, f"Legacy {se['name']}") for i, s in enumerate(se["sessions"], 1)],
        })
    eras["era-2"]["seasons"].append({
        "id": "s1", "name": "Season 1", "number": 1, "system": "pnl",
        "sessions": [clean_session(s, i, "Era 2 Season 1") for i, s in enumerate(era2["sessions"], 1)],
    })
    eras["era-2"]["seasons"].append({"id": "s2", "name": "Season 2", "number": 2, "system": "pnl", "sessions": []})
    return eras


def summarise(eras):
    """Totals used for verification. Money is compared in whole pence (integers)."""
    out = {"seasons": {}, "players": defaultdict(int), "eras": {}}
    for era_id, era in eras.items():
        era_p = 0
        for se in era["seasons"]:
            key = f"{era_id}/{se['id']}"
            sess_p = {s["seq"]: sum(pence(r["final"] - r["buyin"]) for r in s["results"]) for s in se["sessions"]}
            out["seasons"][key] = {
                "sessions": len(se["sessions"]),
                "results": sum(len(s["results"]) for s in se["sessions"]),
                "pnl_pence": sum(sess_p.values()),
                "per_session": sess_p,
            }
            era_p += sum(sess_p.values())
            for s in se["sessions"]:
                for r in s["results"]:
                    out["players"][(era_id, r["player"])] += pence(r["final"] - r["buyin"])
        out["eras"][era_id] = era_p
    return out


def print_summary(eras, title):
    sm = summarise(eras)
    print(f"\n{title}")
    print(f"  {'Season':<22}{'Sessions':>9}{'Results':>9}{'PnL total':>12}")
    for era_id, era in eras.items():
        for se in era["seasons"]:
            row = sm["seasons"][f"{era_id}/{se['id']}"]
            print(f"  {era['name'] + ' · ' + se['name']:<22}{row['sessions']:>9}{row['results']:>9}{row['pnl_pence'] / 100:>+12.2f}")
    players = sorted({p for (_, p) in sm["players"]})
    print(f"  Players ({len(players)}): {', '.join(players)}")
    return sm


# ── Firestore ───────────────────────────────────────────────────────────────

def connect(key_path):
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        fail("firebase-admin isn't installed. Use migration/.venv/bin/python (see migration/README.md).")
    if not os.path.isfile(key_path):
        fail(f"Admin key not found at {key_path}")
    with open(key_path) as f:
        key_project = json.load(f).get("project_id")
    if key_project != PROJECT_ID:
        fail(f"Admin key is for project {key_project!r}, expected {PROJECT_ID!r}")
    firebase_admin.initialize_app(credentials.Certificate(key_path))
    return firestore.client()


def write_all(db, eras):
    ops = []  # (doc_ref, data)
    ops.append((db.document("config/app"), {"activeSeasonNumber": 2}))
    players = set()
    for era_id, era in eras.items():
        ops.append((db.document(f"eras/{era_id}"), {"name": era["name"], "number": era["number"]}))
        for se in era["seasons"]:
            base = f"eras/{era_id}/seasons/{se['id']}"
            ops.append((db.document(base), {"name": se["name"], "number": se["number"], "system": se["system"]}))
            for s in se["sessions"]:
                ops.append((db.document(f"{base}/sessions/{s['seq']:03d}"), s))
                players.update(r["player"] for r in s["results"])
    for p in sorted(players):
        ops.append((db.document(f"players/{p}"), {"name": p}))

    for i in range(0, len(ops), 400):  # Firestore batches max out at 500 writes
        batch = db.batch()
        for ref, data in ops[i:i + 400]:
            batch.set(ref, data)
        batch.commit()
    print(f"\nWrote {len(ops)} documents.")


def delete_existing(db):
    n = 0
    for era in db.collection("eras").list_documents():
        for se in era.collection("seasons").list_documents():
            for s in se.collection("sessions").list_documents():
                s.delete(); n += 1
            se.delete(); n += 1
        era.delete(); n += 1
    for p in db.collection("players").list_documents():
        p.delete(); n += 1
    db.document("config/app").delete(); n += 1
    print(f"Deleted {n} existing documents (--force).")


def read_back(db):
    eras = {}
    for era_snap in db.collection("eras").stream():
        e = era_snap.to_dict()
        seasons = []
        for se_snap in era_snap.reference.collection("seasons").stream():
            se = se_snap.to_dict()
            sessions = sorted((s.to_dict() for s in se_snap.reference.collection("sessions").stream()),
                              key=lambda s: s["seq"])
            seasons.append({"id": se_snap.id, **se, "sessions": sessions})
        seasons.sort(key=lambda s: s["number"])
        eras[era_snap.id] = {**e, "seasons": seasons}
    cfg = db.document("config/app").get().to_dict()
    players = {p.id: p.to_dict() for p in db.collection("players").stream()}
    return eras, cfg, players


def verify(expected, db):
    actual, cfg, players = read_back(db)
    problems = []

    def check(cond, msg):
        if not cond:
            problems.append(msg)

    check(cfg == {"activeSeasonNumber": 2}, f"config/app is {cfg}, expected {{'activeSeasonNumber': 2}}")
    check(set(actual) == set(expected), f"eras in Firestore {sorted(actual)} != expected {sorted(expected)}")

    for era_id, era in expected.items():
        a_era = actual.get(era_id)
        if not a_era:
            continue
        check((a_era.get("name"), a_era.get("number")) == (era["name"], era["number"]), f"{era_id} name/number differ")
        a_ids = [s["id"] for s in a_era["seasons"]]
        e_ids = [s["id"] for s in era["seasons"]]
        check(a_ids == e_ids, f"{era_id} seasons {a_ids} != expected {e_ids}")
        for e_se, a_se in zip(era["seasons"], a_era["seasons"]):
            where = f"{era['name']} {e_se['name']}"
            for k in ("name", "number", "system"):
                check(a_se.get(k) == e_se[k], f"{where}: {k} is {a_se.get(k)!r}, expected {e_se[k]!r}")
            check(len(a_se["sessions"]) == len(e_se["sessions"]),
                  f"{where}: {len(a_se['sessions'])} sessions in Firestore, expected {len(e_se['sessions'])}")
            for e_s, a_s in zip(e_se["sessions"], a_se["sessions"]):
                # Exact comparison of every field, including every buy-in and final amount.
                check(a_s == e_s, f"{where} {e_s['name']}: Firestore copy differs from source\n"
                                  f"      expected {e_s}\n      got      {a_s}")

    e_sum, a_sum = summarise(expected), summarise(actual)
    for k, e in e_sum["seasons"].items():
        a = a_sum["seasons"].get(k)
        check(a is not None and (a["sessions"], a["results"], a["pnl_pence"], a["per_session"])
              == (e["sessions"], e["results"], e["pnl_pence"], e["per_session"]),
              f"{k}: counts/PnL differ (expected {e['sessions']} sessions, {e['results']} results, "
              f"{e['pnl_pence'] / 100:+.2f}; got {a and (a['sessions'], a['results'], a['pnl_pence'] / 100)})")
    check(dict(a_sum["players"]) == dict(e_sum["players"]), "per-player PnL totals differ")
    check(a_sum["eras"] == e_sum["eras"], f"era PnL totals differ: expected {e_sum['eras']}, got {a_sum['eras']}")

    exp_players = {p for (_, p) in e_sum["players"]}
    check(set(players) == exp_players, f"players collection {sorted(players)} != expected {sorted(exp_players)}")
    check(all(v == {"name": k} for k, v in players.items()), "a player document has unexpected fields")

    print_summary(actual, "Read back from Firestore:")
    if problems:
        print(f"\n✗ VERIFICATION FAILED — {len(problems)} problem(s):")
        for p in problems:
            print(f"  • {p}")
        sys.exit(1)
    n_sessions = sum(v["sessions"] for v in e_sum["seasons"].values())
    n_results = sum(v["results"] for v in e_sum["seasons"].values())
    print(f"\n✓ VERIFIED: {n_sessions} sessions and {n_results} results match the source exactly, "
          f"field by field; PnL matches to the penny per session, season, era and player "
          f"({len(e_sum['players'])} player-era totals).")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", default=DEFAULT_KEY)
    ap.add_argument("--backup", default=DEFAULT_BACKUP)
    ap.add_argument("--era2", default=DEFAULT_ERA2)
    ap.add_argument("--dry-run", action="store_true", help="check inputs and print expected totals; no Firebase")
    ap.add_argument("--verify-only", action="store_true", help="don't write; just verify Firestore against the sources")
    ap.add_argument("--force", action="store_true", help="delete existing Firestore data first and re-migrate")
    args = ap.parse_args()

    expected = build_target(args.backup, args.era2)
    print_summary(expected, "Expected (from source files):")
    if args.dry_run:
        print("\nDry run: inputs look valid. Nothing was written.")
        return

    db = connect(args.key)
    if not args.verify_only:
        existing = list(db.collection("eras").limit(1).stream()) or db.document("config/app").get().exists
        if existing and not args.force:
            fail("Firestore already has data. Re-run with --verify-only to check it, or --force to wipe and re-migrate.")
        if existing:
            delete_existing(db)
        write_all(db, expected)
    verify(expected, db)


if __name__ == "__main__":
    main()
