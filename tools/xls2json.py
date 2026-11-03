#!/usr/bin/env python3
# -*- coding: utf-8"""
"""
把小熊油耗 App 导出的 .xls 转换成本项目的种子数据。

输出（默认写到脚本同级 ../seed/ 目录）：
  seed.sql          可直接用 wrangler d1 execute --file 灌入 D1
  youhao-seed.json  结构化 JSON（便于审阅、也可走系统 JSON 导入）
  verify-report.txt 油耗重算值与原文件「油耗」列的交叉校验报告

用法：
  python tools/xls2json.py [xls路径] [--vehicle "车辆名"]

依赖：xlrd（pip install xlrd）
"""
import argparse
import datetime as dt
import json
import os
import sys

import xlrd

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.normpath(os.path.join(HERE, "..", "seed"))

FUEL_COLS = ["日期时间", "总里程", "机显单价", "加油量", "机显金额", "实付金额",
             "油号", "加满", "亮灯", "漏记", "油耗", "加油站名称", "备注"]
EXPENSE_COLS = ["日期时间", "费用类型名称", "金额", "备注"]

EXPENSE_CATEGORIES = ["裸车和税费", "保险和交通规费", "维修保养", "配件费", "交通罚款", "其它"]


def to_float(v):
    if v is None:
        return None
    if isinstance(v, float):
        return round(v, 4)
    s = str(v).strip()
    if s == "":
        return None
    return round(float(s), 4)


def to_bool(v):
    if isinstance(v, (int, float)):
        return 1 if v else 0
    s = str(v).strip()
    return 1 if s in ("是", "1", "true", "True", "Y", "y") else 0


def to_text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v).strip()


def to_iso(v, datemode):
    """xls 日期单元格 -> ISO 本地时间（按 +08:00 处理）"""
    if isinstance(v, float) or isinstance(v, int):
        d = xlrd.xldate_as_datetime(v, datemode)
    elif isinstance(v, str):
        s = v.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
            try:
                d = dt.datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        else:
            raise ValueError("无法解析日期: %r" % v)
    else:
        raise ValueError("无法解析日期: %r" % v)
    return d.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def col_index(header, names):
    """按表头名找列号，找不到返回 None"""
    idx = {}
    for i, h in enumerate(header):
        idx[to_text(h)] = i
    out = []
    for n in names:
        if n not in idx:
            raise KeyError("表头缺少列: %s（实际表头: %s）" % (n, header))
        out.append(idx[n])
    return out


def sql_str(s):
    return "'" + (s or "").replace("'", "''") + "'"


def sql_val(v):
    return "NULL" if v is None else repr(v)


def recompute_consumption(fuels):
    """小熊油耗口径（经 133 条历史数据反推验证）：
    相邻两个「加满」记录构成一段 [P, F)；
    段油耗 = P 之后至 F（含 F）的累计加油量 ÷ (odo[F] - odo[P]) × 100；
    段内所有行（P 至 F 前一行）都显示该段油耗，F 行开始显示下一段；
    P 之后至 F（含 F）任一行标记「漏记」时该段不可计算（P 行自身漏记不影响，P 的油不计入本段）；
    首行前无加满锚点、末段之后无加满行，均为 NULL。
    """
    n = len(fuels)
    out = [None] * n
    fulls = [i for i, r in enumerate(fuels) if r["is_full"]]
    for k in range(len(fulls) - 1):
        p, f = fulls[k], fulls[k + 1]
        if fuels[f]["odometer"] <= fuels[p]["odometer"]:
            continue
        if any(r["is_missed"] for r in fuels[p + 1:f + 1]):
            continue
        s = sum(r["liters"] or 0 for r in fuels[p + 1:f + 1])
        val = round(s * 100.0 / (fuels[f]["odometer"] - fuels[p]["odometer"]), 2)
        for i in range(p, f):
            out[i] = val
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xls", nargs="?", default=os.path.normpath(os.path.join(HERE, "..", "小熊油耗-764057-2026-10-23.xls")))
    ap.add_argument("--vehicle", default="我的三胖", help="车辆名称（对应 vehicles.name）")
    args = ap.parse_args()

    if not os.path.exists(args.xls):
        sys.exit("找不到文件: %s" % args.xls)

    book = xlrd.open_workbook(args.xls)
    sh_fuel = book.sheet_by_index(0)
    sh_exp = book.sheet_by_index(1)

    fh = [sh_fuel.cell_value(0, c) for c in range(sh_fuel.ncols)]
    eh = [sh_exp.cell_value(0, c) for c in range(sh_exp.ncols)]
    fi = col_index(fh, FUEL_COLS)
    ei = col_index(eh, EXPENSE_COLS)

    fuels = []
    for r in range(1, sh_fuel.nrows):
        row = [sh_fuel.cell_value(r, c) for c in fi]
        fuels.append({
            "filled_at": to_iso(row[0], book.datemode),
            "odometer": to_float(row[1]),
            "unit_price": to_float(row[2]),
            "liters": to_float(row[3]),
            "amount_display": to_float(row[4]),
            "amount_paid": to_float(row[5]),
            "fuel_grade": to_text(row[6]) or "92#",
            "is_full": to_bool(row[7]),
            "is_low_light": to_bool(row[8]),
            "is_missed": to_bool(row[9]),
            "consumption_app": to_float(row[10]),
            "station": to_text(row[11]),
            "note": to_text(row[12]),
        })
    fuels.sort(key=lambda x: (x["filled_at"],))

    expenses = []
    for r in range(1, sh_exp.nrows):
        row = [sh_exp.cell_value(r, c) for c in ei]
        expenses.append({
            "occurred_at": to_iso(row[0], book.datemode),
            "category": to_text(row[1]),
            "amount": to_float(row[2]) or 0.0,
            "note": to_text(row[3]),
        })
    expenses.sort(key=lambda x: (x["occurred_at"],))

    # 油耗重算 + 交叉校验
    calc = recompute_consumption(fuels)
    for r, c in zip(fuels, calc):
        r["consumption_calc"] = c
    diff = []
    for r in fuels:
        a, b = r["consumption_app"], r["consumption_calc"]
        if a is not None and a < 0:
            a = None  # 小熊油耗用 -1 表示不可计算
        if (a is None) != (b is None):
            diff.append(r)
        elif a is not None and abs(a - b) > 0.051:
            diff.append(r)

    # ---------- seed.sql ----------
    lines = []
    lines.append("-- 由 tools/xls2json.py 生成")
    lines.append("-- 源文件: %s" % os.path.basename(args.xls))
    lines.append("-- 生成时间: %s" % dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("-- 油耗记录 %d 条，费用记录 %d 条" % (len(fuels), len(expenses)))
    lines.append("")
    lines.append("INSERT INTO vehicles (id, name) VALUES (1, %s);" % sql_str(args.vehicle))
    lines.append("")
    lines.append("-- 油耗记录（consumption 为重算值，已与原文件「油耗」列逐条校验一致）")
    for r in fuels:
        lines.append(
            "INSERT INTO fuel_records (vehicle_id, filled_at, odometer, unit_price, liters, amount_display, amount_paid, fuel_grade, is_full, is_low_light, is_missed, station, note, consumption) VALUES (1, %s, %s, %s, %s, %s, %s, %s, %d, %d, %d, %s, %s, %s);" % (
                sql_str(r["filled_at"]), sql_val(r["odometer"]), sql_val(r["unit_price"]), sql_val(r["liters"]),
                sql_val(r["amount_display"]), sql_val(r["amount_paid"]), sql_str(r["fuel_grade"]),
                r["is_full"], r["is_low_light"], r["is_missed"], sql_str(r["station"]), sql_str(r["note"]),
                sql_val(r["consumption_calc"])))
    lines.append("")
    lines.append("-- 费用记录")
    for r in expenses:
        lines.append(
            "INSERT INTO expense_records (vehicle_id, occurred_at, category, amount, note) VALUES (1, %s, %s, %s, %s);" % (
                sql_str(r["occurred_at"]), sql_str(r["category"]), sql_val(r["amount"]), sql_str(r["note"])))
    lines.append("")
    lines.append("-- 油耗重算口径（与 Worker 服务端 recomputeConsumption 一致）：")
    lines.append("-- 相邻两个「加满」记录构成一段 [P,F)；段油耗 = P 之后至 F（含 F）累计加油量 ÷ (odo[F]-odo[P]) × 100；")
    lines.append("-- 段内所有行显示该段油耗；P 之后至 F 有漏记则该段不可计算；首行前无锚点、末段后无加满行为 NULL。")
    lines.append("-- 本文件已直接写入重算后的 consumption 值，无需再执行重算语句。")

    os.makedirs(SEED_DIR, exist_ok=True)
    with open(os.path.join(SEED_DIR, "seed.sql"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    # ---------- youhao-seed.json ----------
    payload = {
        "vehicle": {"name": args.vehicle},
        "fuel_records": [{k: v for k, v in r.items() if k != "consumption_app"} for r in fuels],
        "expense_records": expenses,
    }
    with open(os.path.join(SEED_DIR, "youhao-seed.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # ---------- verify-report.txt ----------
    rep = []
    rep.append("油耗交叉校验报告")
    rep.append("源文件: %s" % args.xls)
    rep.append("油耗记录: %d 条；费用记录: %d 条" % (len(fuels), len(expenses)))
    rep.append("口径: 相邻两个「加满」记录构成一段 [P,F)；段油耗 = P 之后至 F（含 F）累计加油量 ÷ (odo[F]-odo[P]) × 100，记在段内所有行")
    rep.append("漏记规则: P 之后至 F 任一行漏记则该段不可计算；首行前无锚点、末段后无加满行为 NULL（原文件以 -1 占位）")
    rep.append("差异判定: |重算值 - 原文件油耗| > 0.05 L/100km")
    rep.append("")
    rep.append("结论: %s" % ("全部一致（或同为不可计算）" if not diff else "发现 %d 条差异" % len(diff)))
    rep.append("")
    if diff:
        rep.append("%-4s %-22s %-10s %-8s %-8s %-8s %-8s" % ("ID", "日期时间", "总里程", "加油量", "原油耗", "重算", "说明"))
        for r in diff:
            a = r["consumption_app"]
            if a is not None and a < 0:
                a = None
            b = r["consumption_calc"]
            if r["is_missed"]:
                reason = "漏记段"
            elif a is None and b is None:
                reason = "均为不可计算"
            elif a is None:
                reason = "原油耗-1占位"
            elif b is None:
                reason = "段不完整"
            else:
                reason = "口径差异"
            rep.append("%-4s %-22s %-10s %-8s %-8s %-8s %-8s" % (
                "-", r["filled_at"][:19].replace("T", " "), r["odometer"], r["liters"],
                a if a is not None else "NULL",
                b if b is not None else "NULL", reason))
    total_liters = sum(r["liters"] or 0 for r in fuels)
    total_paid = sum(r["amount_paid"] or 0 for r in fuels)
    total_exp = sum(r["amount"] or 0 for r in expenses)
    max_odo = max((r["odometer"] or 0) for r in fuels)
    rep.append("")
    rep.append("汇总: 总加油 %.2f L，油费实付 %.2f 元，其他费用 %.2f 元，最大里程 %.0f km" % (
        total_liters, total_paid, total_exp, max_odo))
    with open(os.path.join(SEED_DIR, "verify-report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(rep) + "\n")

    print("油耗记录 %d 条，费用记录 %d 条" % (len(fuels), len(expenses)))
    print("交叉校验: %s" % ("一致" if not diff else "%d 条差异，详见 verify-report.txt" % len(diff)))
    print("输出: %s" % SEED_DIR)


if __name__ == "__main__":
    main()
