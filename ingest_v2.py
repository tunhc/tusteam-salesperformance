"""
Yes4All Sales Dashboard — v2 bulk loader (writes .sql files, no network).

Builds numbered SQL files you paste into Supabase → SQL Editor, in order:

  00_schema_v2.sql            copy of supabase_schema_v2.sql (run once)
  01_skus.sql                 SKU master from the follow-up "Tracking_0925" tab,
                              inventory from USA Inventory "report", labels/RRP
                              from the monthly target file
  02_targets_<yyyy_mm>.sql    monthly target (team rows, final columns AD..AH)
  03_inventory_incoming.sql   salable snapshot + weekly incoming (Y4A + AMZ)
  04_demand_forecast.sql      6-month demand (units, GMV) by SKU
  06_cm3.sql                  CM3 per unit before marketing (optional --cm3-html)
  08_cm3_cost_stack.sql       CM3 calculator inputs per SKU (optional --cm3-html; needs schema v3)
  07_weekly_notes.sql         PIC notes from the Excel KPI tracker Week tabs (optional --kpi-tracker)
  05_market.sql               market research extracts (variation × brand,
                              brand monthly, ASIN weekly price/units)
  10_sales_history_NN.sql     daily sales, SKU × day, split into parts.
                              These rows are locked (<= LOCK_BEFORE) by a
                              trigger; each part unlocks for its own session.

Usage:
  python ingest_v2.py --out ./sql_out \
      --followup "Yes4all_follow_up.xlsx" --tracking-sheet Tracking_0925 \
      --inventory "USA_Inventory_Y4A-AMZ.xlsx" \
      --target "SSO_US_Oct_Target_20260922.xlsx" --target-month 2026-10-01 --team "Team Cẩm Tú" \
      --daily "Yes4All_data_tusteam_2023-2024_daily.xlsx" "Yes4All_data_tusteam_2025_daily.xlsx" "Yes4All_data_tusteam_2026_daily.xlsx" \
      --market-dir ./Markets

Never commit the generated .sql files: they contain real sales figures.
"""
import argparse
import glob
import json
import math
import os
import re
import shutil
import warnings
from datetime import date, datetime

import pandas as pd

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------
def lit(v):
    if v is None:
        return "null"
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int,)):
        return str(v)
    if isinstance(v, float):
        r = round(v, 4)
        return str(int(r)) if r == int(r) else repr(r)
    if isinstance(v, (datetime, pd.Timestamp)):
        return "'" + v.strftime("%Y-%m-%d") + "'"
    if isinstance(v, date):
        return "'" + v.isoformat() + "'"
    return "'" + str(v).replace("'", "''") + "'"


def upsert_sql(table, cols, rows, conflict, update=None, batch=1000):
    update = [c for c in (update or cols) if c not in conflict]
    out = []
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        values = ",\n".join("(" + ",".join(lit(r.get(c)) for c in cols) + ")" for r in chunk)
        sets = ", ".join(f"{c} = excluded.{c}" for c in update)
        action = f"do update set {sets}" if sets else "do nothing"
        out.append(f"insert into {table} ({', '.join(cols)}) values\n{values}\non conflict ({', '.join(conflict)}) {action};")
    return "\n\n".join(out)


# The Supabase SQL Editor rejects large scripts, so sales history is written
# compactly: one text line per row inside a dollar-quoted literal, split on
# "|" in SQL. Zero is written as an empty field, the date as days since
# HIST_EPOCH, category/source_file as 1-based indexes into arrays.
HIST_EPOCH = date(2023, 1, 1)


def _cnum(v):
    f = num(v)
    if f == 0:
        return ""
    return str(int(f)) if f == int(f) else repr(round(f, 6))


def compact_sales_sql(rows):
    cats = sorted({r.get("category") or "" for r in rows})
    srcs = sorted({r.get("source_file") or "" for r in rows})
    ci = {c: i + 1 for i, c in enumerate(cats)}
    si = {c: i + 1 for i, c in enumerate(srcs)}
    nums = SALES_COLS[2:-2]
    lines = []
    for r in rows:
        d = r["date"]
        d = d.date() if hasattr(d, "date") and callable(d.date) else d
        if isinstance(d, str):
            d = date.fromisoformat(d[:10])
        lines.append("|".join([str(r["sku"]), str((d - HIST_EPOCH).days)] + [_cnum(r.get(c)) for c in nums] +
                              [str(ci[r.get("category") or ""]), str(si[r.get("source_file") or ""])]))
    arr = lambda xs: "array[" + ",".join(lit(x or None) for x in xs) + "]::text[]"
    sel = ",\n  ".join([f"coalesce(nullif(f[{i + 3}], '')::numeric, 0)" for i in range(len(nums))])
    n = len(nums)
    data = "\n".join(lines)
    assert "$d$" not in data
    return (f"insert into {'sales_daily'} ({', '.join(SALES_COLS)})\n"
            f"select f[1], date '{HIST_EPOCH.isoformat()}' + f[2]::int,\n  {sel},\n"
            f"  ({arr(cats)})[f[{n + 3}]::int], ({arr(srcs)})[f[{n + 4}]::int]\n"
            f"from regexp_split_to_table($d$\n{data}\n$d$, '[\\r\\n]+') as l(x), string_to_array(x, '|') as f\n"
            f"where x <> ''\n"
            f"on conflict (sku, date) do update set {', '.join(f'{c} = excluded.{c}' for c in SALES_COLS[2:])};")


def hourly_month_rows(path, month, known_skus):
    """Aggregate an "SSO Data Extraction Hourly" export to one row per SKU per
    day for `month` (YYYY-MM). Same mapping as the ingest-sales Edge Function,
    plus the ad-type / promo-type / click / impression columns it has."""
    d = pd.read_excel(path)
    d["date"] = pd.to_datetime(d["date"]).dt.date
    if month:
        d = d[d["date"].map(lambda x: x.strftime("%Y-%m") == month)]
    d = d[d["sku"].astype(str).str.strip().isin(known_skus)].copy()
    d["sku"] = d["sku"].astype(str).str.strip()
    num_cols = [c for c in d.columns if c not in ("date", "department", "sku", "asin", "main_category")]
    for c in num_cols:
        d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0)
    g = d.groupby(["sku", "date"], as_index=False).agg({**{c: "sum" for c in num_cols}, "main_category": "first"})
    src = re.sub(r"^[0-9a-f]{8}-", "", os.path.basename(path)).replace("_--_", " -- ").replace("_", " ")
    rows = []
    for r in g.to_dict("records"):
        rows.append({
            "sku": r["sku"], "date": r["date"],
            "units": r["ordered_units"], "gmv": r["ordered_gmv"], "ordered_nmv": r["ordered_nmv"],
            "ads": r["total_ads"], "promo": r["total_promo"],
            "ads_gmv": r["sb_ordered_nmv"] + r["sd_ordered_nmv"] + r["sp_ordered_nmv"],
            "ads_units": r["sb_ordered_units"] + r["sd_ordered_units"] + r["sp_ordered_units"],
            "total_clicks": r["sb_clicks"] + r["sd_clicks"] + r["sp_clicks"],
            "total_impressions": r["sb_impressions"] + r["sd_impressions"] + r["sp_impressions"],
            "glance_views": 0, "ordered_revenue": 0,
            "sp_spend": r["sp_spend"], "sb_spend": r["sb_spend"], "sd_spend": r["sd_spend"], "dsp_spend": 0, "aff_spend": 0,
            "promo_deal": r["best_deal_spend"] + r["lightning_deal_spend"] + r["vm_promo_spend"],
            "promo_coupon": r["coupon_spend"], "promo_discount": r["price_discount_spend"],
            "category": r["main_category"], "source_file": src,
        })
    return rows


def replace_days_sql(rows):
    """Replace exactly the days present in the export (other days untouched)."""
    days = sorted({r["date"] for r in rows})
    lst = ", ".join(f"'{d}'" for d in days)
    return (f"begin;\n-- replace {len(days)} day(s): {days[0]} → {days[-1]}; other days are not touched\n"
            f"delete from sales_daily where date in ({lst});\n\n" + compact_sales_sql(rows) + "\n\ncommit;")


def overwrite_month_sql(rows, month):
    first = date.fromisoformat(month + "-01")
    nxt = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
    return (f"begin;\n-- replace every {month} row (also SKUs missing from the new file)\n"
            f"delete from sales_daily where date >= '{first}' and date < '{nxt}';\n\n"
            + compact_sales_sql(rows) + "\n\ncommit;")


def _row_bytes(r):
    return len(str(r["sku"])) + 6 + sum(len(_cnum(r.get(c))) + 1 for c in SALES_COLS[2:-2]) + 6


def market_research_sql(reports, insights, tables):
    jl = lambda v: lit(json.dumps(v, ensure_ascii=False, default=str)) + "::jsonb"
    out = ["truncate market_insights, market_tables, market_reports;"]
    out.append(upsert_sql("market_reports", ["source", "category", "kind", "title", "pic", "product_line", "plan_date"],
                          [{k: (str(v) if v is not None else None) for k, v in r.items()} for r in reports], ["source"]))
    cols = ["category", "source", "sheet", "section", "label", "content", "sort"]
    for i in range(0, len(insights), 40):
        vals = ",\n".join("(" + ",".join(lit(x.get(c)) for c in cols) + ")" for x in insights[i:i + 40])
        out.append(f"insert into market_insights ({', '.join(cols)}) values\n{vals};")
    for i in range(0, len(tables), 10):
        vals = ",\n".join("(" + ",".join([lit(t["category"]), lit(t["source"]), lit(t["sheet"]), lit(t["section"]), lit(t["title"]),
                                             jl(t["columns"]), jl(t["rows"]), lit(t["sort"])]) + ")" for t in tables[i:i + 10])
        out.append(f"insert into market_tables (category, source, sheet, section, title, columns, rows, sort) values\n{vals};")
    return "\n\n".join(out)


def split_by_size(rows, max_bytes, render):
    """Split rows so each rendered part stays under max_bytes (~3 KB reserved for the SQL around the data)."""
    parts, cur, size = [], [], 3000
    for r in rows:
        b = _row_bytes(r)
        if cur and size + b > max_bytes:
            parts.append(cur); cur, size = [], 3000
        cur.append(r); size += b
    if cur:
        parts.append(cur)
    out = []
    for c in parts:
        body = render(c)
        assert len(body.encode()) <= max_bytes, "part larger than expected"
        out.append((c, body))
    return out


def num(v, default=0.0):
    try:
        if v is None or (isinstance(v, str) and not v.strip()):
            return default
        f = float(v)
        return default if math.isnan(f) else f
    except (TypeError, ValueError):
        return default


def txt(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    s = str(v).strip()
    return s or None


def write(out_dir, name, body, header=""):
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"-- {name} · generated {datetime.now():%Y-%m-%d %H:%M} by ingest_v2.py\n{header}\n{body}\n")
    print(f"  wrote {name:34s} {os.path.getsize(path)/1e6:6.2f} MB", flush=True)
    return path


def write_split(out_dir, stem, body, header="", max_bytes=600_000):
    """Write body as stem.sql, or stem_1.sql, stem_2.sql … split between
    statements when it is too large for the Supabase SQL Editor."""
    if len(body.encode()) <= max_bytes:
        return [write(out_dir, f"{stem}.sql", body, header)]
    stmts = [x for x in re.split(r"\n\n(?=insert into |truncate |delete from |update |select )", body) if x.strip()]
    parts, cur = [], ""
    for st in stmts:
        if cur and len((cur + st).encode()) > max_bytes:
            parts.append(cur); cur = ""
        cur += ("\n\n" if cur else "") + st
    parts.append(cur)
    return [write(out_dir, f"{stem}_{i + 1}.sql", b, header + f"\n-- part {i + 1}/{len(parts)}, run in order")
            for i, b in enumerate(parts)]


# ---------------------------------------------------------------------------
# 1) SKU master
# ---------------------------------------------------------------------------
def load_tracking(path, sheet):
    t = pd.read_excel(path, sheet_name=sheet, header=3)
    t = t[t["SKU"].notna()].copy()
    t["SKU"] = t["SKU"].astype(str).str.strip()
    return t.drop_duplicates("SKU")


def load_inventory_report(path):
    raw = pd.read_excel(path, sheet_name="report", header=None)
    head = raw.iloc[3].tolist()
    week_row = raw.iloc[1].tolist()
    body = raw.iloc[4:].copy()
    body.columns = range(body.shape[1])
    snap = raw.iloc[1, 5]
    snapshot_date = pd.Timestamp(snap).date() if isinstance(snap, (datetime, pd.Timestamp)) else date.today()
    idx = {h: i for i, h in enumerate(head) if isinstance(h, str) and not h.startswith("incoming_")}
    inc_cols = [i for i, h in enumerate(head) if isinstance(h, str) and h.startswith("incoming_")]
    half = len(inc_cols) // 2
    y4a_cols, amz_cols = inc_cols[:half], inc_cols[half:]
    per_sku, incoming = {}, {}
    for _, r in body.iterrows():
        sku = txt(r[idx["SKU"]])
        if not sku:
            continue
        rec = per_sku.setdefault(sku, {"salable_y4a": 0.0, "salable_amz": 0.0, "asin_status": None, "seen_y4a": False})
        # Y4A stock is per SKU and repeated on every ASIN row; AMZ stock is per ASIN.
        if not rec["seen_y4a"]:
            rec["salable_y4a"] = num(r[idx["SALABLE Y4A"]])
            rec["seen_y4a"] = True
            for c in y4a_cols:
                q = num(r[c])
                if q:
                    wk = pd.Timestamp(week_row[c]).date()
                    incoming.setdefault((sku, wk), [0.0, 0.0])[0] += q
        rec["salable_amz"] += num(r[idx["SALABLE AMZ"]])
        st = txt(r[idx["ASIN STATUS"]])
        if st == "active" or rec["asin_status"] is None:
            rec["asin_status"] = st
        for c in amz_cols:
            q = num(r[c])
            if q:
                wk = pd.Timestamp(week_row[c]).date()
                incoming.setdefault((sku, wk), [0.0, 0.0])[1] += q
    return snapshot_date, per_sku, incoming


def load_target(path, team):
    t = pd.read_excel(path, sheet_name=0, header=1)
    c = list(t.columns)
    t["SKU"] = t[c[0]].astype(str).str.strip()
    t["_team"] = t[c[6]].astype(str)
    # final columns AD..AH (0-based 29..33): units, GMV, MKT plan, Ads, Promo
    t["_units"] = pd.to_numeric(t[c[29]], errors="coerce")
    t["_gmv"] = pd.to_numeric(t[c[30]], errors="coerce")
    t["_mkt"] = pd.to_numeric(t[c[31]], errors="coerce")
    t["_ads"] = pd.to_numeric(t[c[32]], errors="coerce")
    t["_promo"] = pd.to_numeric(t[c[33]], errors="coerce")
    labels = {}
    for _, r in t.iterrows():
        labels[r["SKU"]] = {
            "asin_target": txt(r[c[1]]), "product_name": txt(r[c[2]]), "category": txt(r[c[3]]),
            "product_line": txt(r[c[4]]), "channel": txt(r[c[7]]), "moc": num(r[c[8]], None),
            "moc_band": txt(r[c[9]]), "portfolio": txt(r[c[10]]), "block_ads": txt(r[c[11]]),
            "war_plan": txt(r[c[12]]), "labels": txt(r[c[13]]), "po_treatment": txt(r[c[14]]),
            "rrp": num(r[c[15]], None), "normal_asp": num(r[c[16]], None), "team": r["_team"],
        }
    team_rows = t[(t["_team"] == team) & (t["_units"].notna() | t["_gmv"].notna())]
    return labels, team_rows


def build_skus(tracking, inv, target_labels, team_rows):
    rows = []
    seen = set()

    def base(sku):
        lab = target_labels.get(sku, {})
        iv = inv.get(sku, {})
        return {
            "sku": sku, "channel": lab.get("channel"), "portfolio": lab.get("portfolio"),
            "moc": lab.get("moc"), "moc_band": lab.get("moc_band"), "rrp": lab.get("rrp"),
            "block_ads": lab.get("block_ads"), "labels": lab.get("labels"), "war_plan": lab.get("war_plan"),
            "po_treatment": lab.get("po_treatment"), "normal_asp": lab.get("normal_asp"),
            "salable_y4a": iv.get("salable_y4a", 0.0), "salable_amz": iv.get("salable_amz", 0.0),
            "asin_status": iv.get("asin_status"),
        }

    for _, r in tracking.iterrows():
        sku = r["SKU"]
        rec = base(sku)
        rec.update({
            "product_name": txt(r.get("Product Name")), "asin": txt(r.get("ASIN")), "pic": txt(r.get("PIC")),
            "main_pl": txt(r.get("New Product line")), "sub_pl": txt(r.get("Old Product Line")),
            "category": txt(r.get("Category")), "lifecycle": txt(r.get("Lifecycle")),
            "selling_type": txt(r.get("Selling type")),
        })
        if sku not in inv:  # fall back to the follow-up file's own stock columns
            rec["salable_y4a"] = num(r.get("SALABLE Y4A"))
            rec["salable_amz"] = num(r.get("SALABLE AMZ"))
            rec["asin_status"] = txt(r.get("ASIN status"))
        rows.append(rec)
        seen.add(sku)
    # target rows for the team that are missing from the follow-up list
    for _, r in team_rows.iterrows():
        sku = r["SKU"]
        if sku in seen:
            continue
        lab = target_labels.get(sku, {})
        rec = base(sku)
        rec.update({"product_name": lab.get("product_name"), "asin": (lab.get("asin_target") or "").split(";")[0].strip() or None,
                    "pic": None, "main_pl": lab.get("product_line"), "sub_pl": None, "category": lab.get("category"),
                    "lifecycle": None, "selling_type": None})
        rows.append(rec)
        seen.add(sku)
    return rows


# ---------------------------------------------------------------------------
# 2) Daily sales history
# ---------------------------------------------------------------------------
SALES_COLS = ["sku", "date", "units", "gmv", "ads", "promo", "ads_gmv", "ads_units", "total_clicks",
              "total_impressions", "glance_views", "ordered_revenue", "ordered_nmv", "sp_spend", "sb_spend",
              "sd_spend", "dsp_spend", "aff_spend", "promo_deal", "promo_coupon", "promo_discount", "category", "source_file"]


def load_daily(paths):
    frames = []
    for p in paths:
        d = pd.read_excel(p)
        d["Day"] = pd.to_datetime(d["Day"], errors="coerce")
        d = d[d["Day"].notna() & d["SKU"].notna()].copy()
        d["_src"] = os.path.basename(p)
        frames.append(d)
    d = pd.concat(frames, ignore_index=True)
    d["SKU"] = d["SKU"].astype(str).str.strip()
    f = lambda c: pd.to_numeric(d[c], errors="coerce").fillna(0) if c in d else 0
    out = pd.DataFrame({
        "sku": d["SKU"], "date": d["Day"].dt.date,
        "units": f("Ordered_units"), "gmv": f("Ordered GMV"), "ads": f("Total ADS"), "promo": f("Total Promo"),
        "ads_gmv": f("Sb_ordered_nmv") + f("Sd_ordered_nmv") + f("Sp_ordered_nmv"),
        "ads_units": f("Sb_ordered_units") + f("Sd_ordered_units") + f("Sp_ordered_units"),
        "total_clicks": f("Sb_clicks") + f("Sd_clicks") + f("Sp_clicks"),
        "total_impressions": f("Sb_impressions") + f("Sd_impressions") + f("Sp_impressions"),
        "glance_views": f("Glance_views"), "ordered_revenue": f("Ordered_revenue"), "ordered_nmv": f("Ordered_nmv"),
        "sp_spend": f("sp_spend"), "sb_spend": f("sb_spend"), "sd_spend": f("sd_spend"),
        "dsp_spend": f("dsp_spend"), "aff_spend": f("aff_spend"),
        "promo_deal": f("Best_deal_spend") + f("Lightning_deal_spend"),
        "promo_coupon": f("Coupon_spend"),
        "promo_discount": f("Price_discount_spend") + f("VM_promo_spend"),
        "category": d["product_line"].astype(str), "source_file": d["_src"],
    })
    num_cols = [c for c in SALES_COLS if c not in ("sku", "date", "category", "source_file")]
    g = out.groupby(["sku", "date"], as_index=False).agg({**{c: "sum" for c in num_cols}, "category": "first", "source_file": "first"})
    for c in num_cols:
        g[c] = g[c].round(2)
    return g


# ---------------------------------------------------------------------------
# 3) Market research extracts
# ---------------------------------------------------------------------------
def _grab_json(h, start):
    i = h.find("{", start)
    depth = 0
    for j in range(i, len(h)):
        if h[j] == "{":
            depth += 1
        elif h[j] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(h[i:j + 1])
    return None


def _mon(label):
    for fmt in ("%b-%y", "%b'%y", "%b %Y"):
        try:
            return datetime.strptime(label.strip(), fmt).date().replace(day=1)
        except ValueError:
            pass
    return None


CATEGORY_BY_FILE = [
    (r"tricep rope", "Tricep Ropes"), (r"soft.?kettlebell", "Soft Kettlebells"), (r"adjustable.?kettlebell", "Adjustable Kettlebells"),
    (r"3-handle", "3-Handle Kettlebells"), (r"adj(ustable)?.?(cast iron)?.?dumbbell", "Adjustable Dumbbells"), (r"cement", "Cement Dumbbells"),
    (r"neoprene", "Neoprene Dumbbells"), (r"balance.?board", "Balance Boards"), (r"balance.?pad", "Balance Pads"),
]


def category_of(fname):
    low = fname.lower()
    for rx, cat in CATEGORY_BY_FILE:
        if re.search(rx, low):
            return cat
    return os.path.splitext(fname)[0]


def parse_market(market_dir):
    variation, brand_monthly, asin_weekly, var_monthly = [], [], [], []
    seen_var = set()
    # xlsx "1.Market": blocks that start with a "Brand name" header row
    for path in sorted(glob.glob(os.path.join(market_dir, "*.xlsx"))):
        cat = category_of(os.path.basename(path))
        try:
            sheet = pd.read_excel(path, sheet_name="1.Market", header=None)
        except Exception:
            continue
        rows = sheet.values.tolist()
        for i, row in enumerate(rows):
            cells = [c for c in row]
            if not any(isinstance(c, str) and c.strip().lower() == "brand name" for c in cells):
                continue
            title = " ".join(str(c) for c in (rows[i - 1] if i else []) if isinstance(c, str)).lower()
            metric = "price" if "price" in title or "asp" in title else "revenue"
            start = next(j for j, c in enumerate(cells) if isinstance(c, str) and c.strip().lower() == "brand name")
            head = cells[start:]
            var_idx = []
            for j, h in enumerate(head):
                if j == 0 or not isinstance(h, (str, int, float)) or (isinstance(h, float) and math.isnan(h)):
                    continue
                hs = str(h).strip()
                if re.search(r"asin|link|total|rating|rank|discount|note|pattern", hs, re.I):
                    if re.search(r"total|rating|rank|discount|pattern|note", hs, re.I) and var_idx:
                        break
                    continue
                var_idx.append((start + j, hs))
            for r in rows[i + 1:i + 40]:
                name = r[start]
                if not isinstance(name, str) or not name.strip() or name.strip().lower() in ("total", "min price", "median price", "y4a vs med", "brand name"):
                    break
                for j, var in var_idx:
                    v = r[j] if j < len(r) else None
                    try:
                        v = float(v)
                    except (TypeError, ValueError):
                        continue
                    if math.isnan(v) or v <= 0:
                        continue
                    key = (cat, var, name.strip(), metric)
                    if key in seen_var:
                        continue
                    seen_var.add(key)
                    variation.append({"category": cat, "attribute": "variation", "variation": var, "brand": name.strip(),
                                      "metric": metric, "value": round(v, 2), "period": "Apr-Jun 2026", "source": os.path.basename(path)})
    # HTML reports with embedded data
    for path in sorted(glob.glob(os.path.join(market_dir, "*.html"))):
        cat = category_of(os.path.basename(path))
        h = open(path, encoding="utf-8", errors="ignore").read()
        src = os.path.basename(path)
        m = re.search(r"const MKT_DATA\s*=", h)
        if m:
            d = _grab_json(h, m.end())
            for s in d.get("series", []):
                for lab, v in zip(d["labels"], s["values"]):
                    mo = _mon(lab)
                    if mo and v is not None:
                        brand_monthly.append({"category": cat, "month": mo, "brand": s["brand"], "revenue": v, "units": None, "avg_price": None, "source": src})
        i = h.find("window.PXDATA=")
        if i > 0:
            d = _grab_json(h, i)
            dates = [datetime.strptime(x, "%m/%d/%Y").date() for x in d["dates"]]
            for s in d["series"]:
                for dt, p, u in zip(dates, s.get("p", []), s.get("u", [])):
                    if p is None and not u:
                        continue
                    asin_weekly.append({"category": cat, "asin": s["a"], "brand": s["b"], "title": (s.get("n") or "")[:200],
                                        "week_start": dt, "price": p, "units": u or 0, "source": src})
        for m in re.finditer(r'window\.SCDATA\["(\w+)"\]=', h):
            d = _grab_json(h, m.end() - 1)
            if not d or d.get("mode") not in (None, "units", "rev", "revenue", "gmv"):
                pass
            k = h.rfind("<h", 0, h.find('id="' + m.group(1) + '"'))
            heading = re.sub("<[^>]+>", "", h[k:k + 200]).lower()
            attr = "color" if "color" in heading else "size" if ("length" in heading or "size" in heading) else "weight" if "weight" in heading else "variation"
            for var in d.get("k", []):
                for lab, v in zip(d["m"], d["d"].get(var, [])):
                    mo = _mon(lab)
                    if mo and v is not None:
                        var_monthly.append({"category": cat, "attribute": attr, "variation": var, "month": mo, "value": v,
                                            "mode": str(d.get("mode") or ""), "source": src + "#" + m.group(1)})
    # brand × variation tables and per-line brand monthly data in the HTML reports
    import market_research as mr
    html_tables = []
    for path in sorted(glob.glob(os.path.join(market_dir, "*.html"))):
        raw = open(path, encoding="utf-8", errors="ignore").read()
        brand_monthly.extend(mr.json_brand_monthly(raw, os.path.basename(path)))
        html_tables.extend(mr.html_research(path, category_of(os.path.basename(path)))[2])
    for v in mr.variation_from_tables(html_tables):
        key = (v["category"], v["variation"], v["brand"], v["metric"])
        if key not in seen_var:
            seen_var.add(key)
            variation.append(v)
    bm = {}
    for r in brand_monthly:
        bm[(r["category"], r["month"], r["brand"])] = r
    brand_monthly = list(bm.values())
    # dedupe var_monthly (charts can repeat)
    uniq = {}
    for r in var_monthly:
        uniq[(r["category"], r["attribute"], r["variation"], r["month"], r["mode"])] = r
    return variation, brand_monthly, asin_weekly, list(uniq.values())


# ---------------------------------------------------------------------------
# 4) CM3 base per unit (from the Y4A CM3 by Lane V9.8 HTML)
#    Ported from yes4all-sales-dashboard/prepare_cm3_mart.py, evaluated with
#    Ads% = Promo% = 0 so only the per-unit margin before marketing is stored.
#    The dashboard then estimates CM3 = units × cm3_unit_base − Ads × 0.985 − Promo
#    (non-SPT lanes). FOB, duty and the other cost inputs never leave this script.
# ---------------------------------------------------------------------------
R_LB = {"DI": 0.00617589, "SPT": 0.00617589, "DS": 0.11579795}
R_CBM = {"DI": 6.207626, "SPT": 6.207626, "DS": 116.392987}
CU_LB, CU_CBM = 0.00634563, 6.378239
ARD = {"DI": 135, "DS": 168, "SPT": 35}
FRATE = 0.115 / 365


def lane_of(channel, canonical):
    c = (channel or "").upper().strip()
    for lane in ("SPT", "DS", "DI"):
        if c.startswith(lane):
            return lane
    cur = (canonical or "").upper()
    return "SPT" if "SPT" in cur else "DS" if "DS" in cur else "DI"


def cm3_unit_base(p, lane):
    if not p.get("ok"):
        return None
    asp = num(p.get("gmv"))
    revenue = num(p.get({"DI": "rdi", "DS": "rds", "SPT": "sptp"}[lane]))
    if asp <= 0 or revenue <= 0:
        return None
    fob, duty, wt, cbm = num(p.get("fob")), num(p.get("duty")), num(p.get("wt")), num(p.get("cbm"))
    c = {k: 0.0 for k in ["fob", "tariff", "inb", "cirro", "vt", "perf", "stor", "pp", "lm", "ads"]}
    c["fob"] = -fob
    c["tariff"] = -fob * duty
    c["inb"] = -max(wt * R_LB[lane], cbm * R_CBM[lane])
    nmv = revenue if lane == "SPT" else asp
    if lane == "DI":
        c["vt"], c["perf"] = -revenue * 0.01, -revenue * 0.005
    elif lane == "DS":
        c["cirro"] = -max(wt * CU_LB, cbm * CU_CBM)
        c["vt"], c["perf"] = -revenue * 0.1375, -revenue * 0.005
        c["stor"] = -cbm * 20.10
        c["pp"] = -(1.50 + max(wt - 20, 0) * 0.10)
    ar = ARD[lane]
    io = 0 if lane in ("DI", "SPT") else 60
    fin = (c["fob"] * (ar - 120) + c["tariff"] * (ar - 68) + (c["inb"] + c["cirro"]) * (ar - io)
           + (c["pp"] + c["lm"]) * (ar - 103)) * FRATE
    pre_tu = revenue + sum(c.values()) + fin
    true_up = 0.0
    if lane in ("DI", "DS") and nmv > 0:
        csa = 0.505 if lane == "DI" else 0.40
        net_ppm = (nmv - revenue + abs(c["vt"]) + abs(c["perf"])) / nmv
        true_up = max(0.0, csa - net_ppm) * nmv
    return round(pre_tu - true_up, 4)


def cm3_stack_sql(html_path, sku_rows):
    html = open(html_path, encoding="utf-8").read()
    payload = json.loads(re.search(r'<script id="DATA" type="application/json">(.*?)</script>', html, re.S).group(1))
    products = {str(p["s"]).strip(): p for p in payload["products"]}
    src = f"{payload.get('v')} · {payload.get('canon')} · built {payload.get('built')}"
    rows = []
    for r in sku_rows:
        p = products.get(r["sku"])
        if not p or not p.get("ok"):
            continue
        rows.append({"sku": r["sku"], "lane": lane_of(r.get("channel"), p.get("cur")), "fob": num(p.get("fob")), "duty": num(p.get("duty")),
                     "weight_lb": num(p.get("wt")), "cbm": num(p.get("cbm")), "asp_canon": num(p.get("gmv")), "rev_di": num(p.get("rdi")),
                     "rev_ds": num(p.get("rds")), "rev_spt": num(p.get("sptp")), "source": src})
    return upsert_sql("cm3_cost_stack", ["sku", "lane", "fob", "duty", "weight_lb", "cbm", "asp_canon", "rev_di", "rev_ds", "rev_spt", "source"], rows, ["sku"])


def build_cm3(html_path, sku_rows):
    html = open(html_path, encoding="utf-8").read()
    m = re.search(r'<script id="DATA" type="application/json">(.*?)</script>', html, re.S)
    payload = json.loads(m.group(1))
    products = {str(p["s"]).strip(): p for p in payload["products"]}
    out = []
    for r in sku_rows:
        p = products.get(r["sku"])
        if not p:
            continue
        lane = lane_of(r.get("channel"), p.get("cur"))
        base = cm3_unit_base(p, lane)
        if base is not None:
            out.append({"sku": r["sku"], "cm3_unit_base": base, "cm3_lane": lane,
                        "cm3_source": f"{payload.get('v')} · {payload.get('canon')} · built {payload.get('built')}"})
    return out


# ---------------------------------------------------------------------------
# 5) PIC weekly notes from the Excel KPI tracker (tabs "Week 1".."Week 4")
#    → weekly_reviews + review_actions, so the knowledge hub starts with history.
#    Week boundaries come from the tracker's Config tab (Sunday → Saturday).
# ---------------------------------------------------------------------------
SKU_STOP = {"ASIN", "PUSH", "DEAL", "BEST", "PRIME", "TYPE", "CASE", "ACOS", "TACOS"}


def parse_actions(text, ws):
    out, cur = [], None
    default_due = ws + pd.Timedelta(days=13)
    for raw in str(text or "").splitlines():
        t = raw.strip()
        if not t:
            continue
        m = re.match(r"^(\d{1,2})/(\d{1,2})\s*[:\-]?\s*(.*)$", t)
        if m:
            day, mon = int(m.group(1)), int(m.group(2))
            year = ws.year + (1 if mon < ws.month - 6 else 0)
            try:
                cur = pd.Timestamp(year=year, month=mon, day=day)
            except ValueError:
                cur = None
            t = m.group(3).strip()
            if not t:
                continue
        t = re.sub(r"^[\-•*·]+\s*", "", t)
        if len(t) < 3:
            continue
        skus = sorted({x for x in re.findall(r"\b[A-Z0-9]{4}\b", t) if re.search(r"[A-Z]", x) and x not in SKU_STOP})
        out.append({"text": t, "due": (cur or default_due).date(), "dated": cur is not None, "skus": skus})
    return out


def build_weekly_notes(tracker_path):
    xl = pd.ExcelFile(tracker_path)
    cfg = pd.read_excel(tracker_path, sheet_name="Config", header=None)
    starts = {}
    for _, r in cfg.iterrows():
        cells = list(r.values)
        for i, c in enumerate(cells):
            m = re.match(r"Tuần (\d) - Bắt đầu", str(c))
            if not m:
                continue
            date_cell = next((x for x in cells[i + 1:] if isinstance(x, (datetime, pd.Timestamp))), None)
            if date_cell is not None:
                starts[int(m.group(1))] = pd.Timestamp(date_cell).normalize()
    reviews, actions = [], []
    for n, ws in sorted(starts.items()):
        sheet = f"Week {n}"
        if sheet not in xl.sheet_names:
            continue
        t = pd.read_excel(tracker_path, sheet_name=sheet)
        col = lambda *names: next((c for c in t.columns if any(nm.lower() in str(c).lower() for nm in names)), None)
        c_pl, c_st, c_is, c_ow, c_ac, c_pic = col("Product Line"), col("Trạng thái"), col("Vấn đề", "Issues"), col("Owner"), col("Hành động", "Next action"), col("PIC")
        for _, r in t.iterrows():
            issue, action = txt(r.get(c_is)) if c_is else None, txt(r.get(c_ac)) if c_ac else None
            pl = txt(r.get(c_pl))
            if not pl or not (issue or action):
                continue
            owner = txt(r.get(c_ow)) or txt(r.get(c_pic))
            reviews.append({"week_start": ws.date(), "main_pl": pl, "owner": owner, "status": txt(r.get(c_st)),
                            "issue_text": issue, "action_text": action})
            for a in parse_actions(action, ws):
                actions.append({"week_start": ws.date(), "main_pl": pl, "owner": owner, **a})
    return sorted(starts.values()), reviews, actions


def weekly_notes_sql(tracker_path):
    weeks, reviews, actions = build_weekly_notes(tracker_path)
    parts = ["-- Freeze the weekly snapshots first (admin run, so re-freezing is allowed).",
             "select set_config('app.import_notes', 'on', false);"]
    parts += [f"select freeze_review_week({lit(w.date())}, true);" for w in weeks]
    if reviews:
        parts.append(upsert_sql("weekly_reviews", ["week_start", "main_pl", "owner", "status", "issue_text", "action_text"],
                                reviews, ["week_start", "main_pl"]))
    for a in actions:
        arr = "array[" + ",".join(lit(s) for s in a["skus"]) + "]::text[]" if a["skus"] else "'{}'::text[]"
        parts.append(
            "insert into review_actions (review_id, week_start, main_pl, owner, text, due_date, due_from_text, skus) "
            f"select id, {lit(a['week_start'])}, {lit(a['main_pl'])}, {lit(a['owner'])}, {lit(a['text'])}, {lit(a['due'])}, {lit(a['dated'])}, {arr} "
            f"from weekly_reviews w where w.week_start = {lit(a['week_start'])} and w.main_pl = {lit(a['main_pl'])} "
            f"and not exists (select 1 from review_actions x where x.review_id = w.id and x.text = {lit(a['text'])});")
    parts.append("select set_config('app.import_notes', 'off', false);")
    return "\n".join(parts), len(reviews), len(actions)


# ---------------------------------------------------------------------------
def write_market(out, market_dir):
    print("market")
    variation, brand_monthly, asin_weekly, var_monthly = parse_market(market_dir)
    body = "\n\n".join(filter(None, [
        "truncate market_variation, market_brand_monthly, market_asin_weekly, market_variation_monthly;",
        upsert_sql("market_variation", ["category", "attribute", "variation", "brand", "metric", "value", "period", "source"], variation,
                   ["category", "variation", "brand", "metric"]) if variation else "",
        upsert_sql("market_brand_monthly", ["category", "month", "brand", "revenue", "units", "avg_price", "source"], brand_monthly,
                   ["category", "month", "brand"]) if brand_monthly else "",
        upsert_sql("market_asin_weekly", ["category", "asin", "brand", "title", "week_start", "price", "units", "source"], asin_weekly,
                   ["asin", "week_start"]) if asin_weekly else "",
        upsert_sql("market_variation_monthly", ["category", "attribute", "variation", "month", "value", "mode", "source"], var_monthly,
                   ["category", "attribute", "variation", "month", "mode"]) if var_monthly else "",
    ]))
    write_split(out, "05_market", body, header=f"-- variation rows {len(variation)}, brand-month {len(brand_monthly)}, asin-week {len(asin_weekly)}, variation-month {len(var_monthly)}")

    print("market research library")
    from market_research import market_library
    reports, tables = market_library(market_dir, category_of)
    insights = []  # the Market tab shows market & competitor data only
    schema = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "supabase_schema_v3.sql"), encoding="utf-8").read()
    ddl = schema[schema.index("-- 6) Market research library"):].split("\n", 1)[1]
    write_split(out, "09_market_research", market_research_sql(reports, insights, tables),
                header=f"-- {len(reports)} reports, {len(tables)} market/competitor tables · creates its tables if missing\n" + ddl)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--followup")
    ap.add_argument("--tracking-sheet", default="Tracking_0925")
    ap.add_argument("--inventory")
    ap.add_argument("--target")
    ap.add_argument("--target-month", help="first day of the target month, e.g. 2026-10-01")
    ap.add_argument("--team", default="Team Cẩm Tú")
    ap.add_argument("--daily", nargs="+")
    ap.add_argument("--market-dir")
    ap.add_argument("--cm3-html", help="Y4A_CM3_by_Lane_V98_*.html")
    ap.add_argument("--kpi-tracker", help="SSO_Sales_KPI_Tracker_*.xlsx (Week 1..4 PIC notes)")
    ap.add_argument("--lock-before", default="2026-09-01")
    ap.add_argument("--hourly", help="SSO Data Extraction Hourly export: overwrite one month of sales_daily (see --overwrite-month)")
    ap.add_argument("--overwrite-month", help="YYYY-MM to replace with the --hourly file, e.g. 2026-09 (deletes the whole month first)")
    ap.add_argument("--max-part-kb", type=int, default=600, help="max size of each sales history file (SQL Editor limit)")
    ap.add_argument("--known-skus", help="with --hourly only: 01_skus.sql (or a text file, one SKU per line) listing the managed SKUs")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    if a.hourly:
        # one-month overwrite from the hourly export, no other inputs needed
        if not a.known_skus:
            ap.error("--hourly needs --known-skus (and optionally --overwrite-month YYYY-MM)")
        txt = open(a.known_skus, encoding="utf-8").read()
        known = set(re.findall(r"^\('([^']+)',", txt, re.M)) or {l.strip() for l in txt.splitlines() if l.strip()}
        rows = hourly_month_rows(a.hourly, a.overwrite_month, known)
        tot = sum(r["gmv"] for r in rows)
        info = f"-- {len(rows)} SKU-day rows, {len({r['sku'] for r in rows})} SKUs, GMV {tot:,.2f} · source {rows[0]['source_file'] if rows else a.hourly}"
        if a.overwrite_month:
            write(a.out, f"11_sales_{a.overwrite_month.replace('-', '_')}_overwrite.sql", overwrite_month_sql(rows, a.overwrite_month), header=info)
        elif rows:
            d0, d1 = min(r["date"] for r in rows), max(r["date"] for r in rows)
            name = f"12_sales_{d0:%Y_%m_%d}" + (f"_to_{d1:%Y_%m_%d}" if d1 != d0 else "") + ".sql"
            write(a.out, name, replace_days_sql(rows), header=info)
        if not a.followup:
            return
    if a.market_dir and not a.followup:
        write_market(a.out, a.market_dir)  # market files only
        return
    for req in ("followup", "inventory", "target", "target_month", "daily"):
        if not getattr(a, req):
            ap.error(f"--{req.replace('_', '-')} is required for a full build")

    print("schema")
    shutil.copy(os.path.join(HERE, "supabase_schema_v2.sql"), os.path.join(a.out, "00_schema_v2.sql"))

    print("sku master")
    tracking = load_tracking(a.followup, a.tracking_sheet)
    snapshot_date, inv, incoming = load_inventory_report(a.inventory)
    labels, team_rows = load_target(a.target, a.team)
    skus = build_skus(tracking, inv, labels, team_rows)
    daily = load_daily(a.daily)
    known = {r["sku"] for r in skus}
    for sku in sorted(set(daily["sku"]) - known):  # sales for SKUs not in the follow-up list
        cat = daily.loc[daily["sku"] == sku, "category"].iloc[0]
        skus.append({"sku": sku, "main_pl": cat, "product_name": None})
    sku_cols = ["sku", "product_name", "asin", "pic", "main_pl", "sub_pl", "category", "lifecycle", "selling_type",
                "asin_status", "salable_y4a", "salable_amz", "channel", "portfolio", "moc", "moc_band", "rrp",
                "block_ads", "labels", "war_plan", "po_treatment", "normal_asp"]
    for r in skus:
        r["inventory_as_of"] = snapshot_date
    write(a.out, "01_skus.sql", upsert_sql("skus", sku_cols + ["inventory_as_of"], skus, ["sku"]))

    if a.cm3_html:
        rows = build_cm3(a.cm3_html, skus)
        write(a.out, "08_cm3_cost_stack.sql", cm3_stack_sql(a.cm3_html, skus), header="-- CM3 calculator inputs (V9.8). Readable only through the cm3_inputs() RPC.")
        write(a.out, "06_cm3.sql", "\n".join(
            f"update skus set cm3_unit_base = {lit(r['cm3_unit_base'])}, cm3_lane = {lit(r['cm3_lane'])}, cm3_source = {lit(r['cm3_source'])} where sku = {lit(r['sku'])};"
            for r in rows), header=f"-- CM3 base per unit for {len(rows)} SKUs")

    print("targets")
    tm = a.target_month
    trows = [{"sku": r["SKU"], "month": tm, "target_units": round(num(r["_units"]), 2), "target_gmv": round(num(r["_gmv"]), 2),
              "ads_target": round(num(r["_ads"]), 2), "promo_target": round(num(r["_promo"]), 2)} for _, r in team_rows.iterrows()]
    tot = {k: round(sum(x[k] for x in trows)) for k in ("target_units", "target_gmv", "ads_target", "promo_target")}
    write(a.out, f"02_targets_{tm[:7].replace('-', '_')}.sql",
          upsert_sql("targets_monthly", ["sku", "month", "target_units", "target_gmv", "ads_target", "promo_target"], trows, ["sku", "month"]),
          header=f"-- {len(trows)} SKUs · totals {tot}")

    print("inventory + incoming")
    scope = known | set(daily["sku"])
    inv_rows = [{"sku": s, "snapshot_date": snapshot_date, "salable_y4a": v["salable_y4a"], "salable_amz": v["salable_amz"]}
                for s, v in inv.items() if s in scope]
    inc_rows = [{"sku": s, "week_start": wk, "qty_y4a": q[0], "qty_amz": q[1], "snapshot_date": snapshot_date}
                for (s, wk), q in incoming.items() if s in scope]
    body = (f"delete from incoming_weekly where snapshot_date = {lit(snapshot_date)};\n\n"
            + upsert_sql("inventory_snapshot", ["sku", "snapshot_date", "salable_y4a", "salable_amz"], inv_rows, ["sku", "snapshot_date"]) + "\n\n"
            + upsert_sql("incoming_weekly", ["sku", "week_start", "qty_y4a", "qty_amz", "snapshot_date"], inc_rows, ["sku", "week_start", "snapshot_date"]))
    write(a.out, "03_inventory_incoming.sql", body)

    print("demand forecast")
    dem = pd.read_excel(a.target, sheet_name=[s for s in pd.ExcelFile(a.target).sheet_names if s.lower().startswith("6 months demand team")][0], header=2)
    months = pd.date_range(tm, periods=6, freq="MS")
    frows = []
    for _, r in dem.iterrows():
        sku = txt(r["SKU"])
        if not sku:
            continue
        for i, mo in enumerate(months):
            frows.append({"sku": sku, "month": mo.date(), "units": round(num(r.iloc[7 + i]), 2), "gmv": round(num(r.iloc[13 + i]), 2),
                          "source": os.path.basename(a.target)})
    frows = [f for f in frows if f["sku"] in known]
    write(a.out, "04_demand_forecast.sql", upsert_sql("demand_forecast_monthly", ["sku", "month", "units", "gmv", "source"], frows, ["sku", "month"]))

    if a.market_dir:
        write_market(a.out, a.market_dir)

    if a.kpi_tracker:
        print("weekly notes")
        body, nr, na = weekly_notes_sql(a.kpi_tracker)
        write(a.out, "07_weekly_notes.sql", body, header=f"-- {nr} PIC notes, {na} actions · run after the sales files")

    print("sales history")
    hist = daily[daily["date"] < pd.Timestamp(a.lock_before).date()].sort_values(["date", "sku"])
    recs = hist.to_dict("records")
    parts = split_by_size(recs, a.max_part_kb * 1000, compact_sales_sql)
    for p, (chunk, body) in enumerate(parts):
        header = ("-- unlock locked history for this session only (see trg_sales_daily_lock)\n"
                  "select set_config('app.unlock_history', 'on', false);\n"
                  f"-- rows {len(chunk)} · {chunk[0]['date']} → {chunk[-1]['date']}")
        write(a.out, f"10_sales_history_{p + 1:02d}.sql", body +
              "\n\nselect set_config('app.unlock_history', 'off', false);", header=header)
    parts = len(parts)
    print(f"done: {len(skus)} SKUs, {len(trows)} target rows, {len(recs)} sales rows in {parts} parts")


if __name__ == "__main__":
    main()
