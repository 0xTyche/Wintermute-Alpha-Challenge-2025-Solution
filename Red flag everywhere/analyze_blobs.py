#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_blobs.py

参考你给的示例代码，重写为更稳健的完整脚本：
- 可从两种来源读取数据：
  1) 单个 result.json（含 {"blobs": [...]}）
  2) data/ 目录下的 blob_batch_*.json（自动遍历并解析混合 JSON/NDJSON）
- 计算相邻 blob 发布间隔，并输出：
  - 时间线图（随时间的间隔，标出异常点，左上角摘要框）
  - 直方图（间隔分布）
  - Markdown 报告（含统计与“显著间隔”表）
  - 证明列表 CSV（逐条间隔复核）
- 异常判定默认为 mean + 2*std（与示例一致），可通过参数调整
- 使用 Matplotlib 非交互后端 Agg，避免 Windows/命令行卡住

用法：
  python analyze_blobs.py                      # 默认从 ./result.json 读取，否则退回 ./data/*.json
  python analyze_blobs.py --result_json my.json
  python analyze_blobs.py --data_dir data --out_dir output --std_k 2.5

依赖：numpy、matplotlib
"""

import argparse
import csv
import glob
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

import numpy as np

# —— 关键：非交互式后端，防止命令行环境卡住（必须在导入 pyplot 之前设置）
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.ioff()
import matplotlib.dates as mdates


# ============================== 数据结构 ==============================

@dataclass
class BlobRecord:
    id: Any
    time: datetime   # 统一为“UTC 无时区（naive）时间”，便于画图
    height: int
    signer: str


# ============================== 解析工具 ==============================

def parse_timestamp_to_utc_naive(s: str) -> datetime:
    """
    解析 ISO8601 时间（兼容以 'Z' 结尾或带偏移量），统一转为 UTC 并去掉 tzinfo（naive）。
    """
    try:
        s = s.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            # 视为 UTC
            return dt
        else:
            return dt.astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def coalesce(d: Dict[str, Any], keys: List[str], default=None):
    for k in keys:
        cur = d
        ok = True
        for p in k.split("."):
            if isinstance(cur, dict) and p in cur:
                cur = cur[p]
            else:
                ok = False
                break
        if ok:
            return cur
    return default


def json_fragments_to_list(text: str) -> List[Dict[str, Any]]:
    """
    将文本尽量解析为对象列表：支持 JSON 数组、单对象、拼接对象、NDJSON。
    """
    text_stripped = text.strip()
    try:
        obj = json.loads(text_stripped)
        if isinstance(obj, list):
            return obj
        if isinstance(obj, dict):
            return [obj]
    except json.JSONDecodeError:
        pass

    decoder = json.JSONDecoder()
    idx, n = 0, len(text_stripped)
    out: List[Dict[str, Any]] = []
    while idx < n:
        while idx < n and text_stripped[idx] in [',', ' ', '\t', '\r', '\n']:
            idx += 1
        if idx >= n:
            break
        try:
            obj, off = decoder.raw_decode(text_stripped, idx)
            if isinstance(obj, dict):
                out.append(obj)
            elif isinstance(obj, list):
                out.extend([x for x in obj if isinstance(x, dict)])
            idx = off
        except json.JSONDecodeError:
            # 尝试 NDJSON
            nd: List[Dict[str, Any]] = []
            for line in text.splitlines():
                s = line.strip().rstrip(',')
                if not s:
                    continue
                try:
                    obj = json.loads(s)
                    if isinstance(obj, dict):
                        nd.append(obj)
                    elif isinstance(obj, list):
                        nd.extend([x for x in obj if isinstance(x, dict)])
                except json.JSONDecodeError:
                    continue
            if nd:
                return nd
            break
    return out


def normalize_record(raw: Dict[str, Any]) -> BlobRecord:
    """
    统一提取 id、time、height、signer。
    time 优先 'time'，回退 'tx.time'。转换为 UTC-naive。
    """
    blob_id = coalesce(raw, ["id", "tx.id", "commitment", "tx.hash"])
    t = coalesce(raw, ["time", "tx.time"])
    if not t:
        raise ValueError("missing 'time'/'tx.time'")
    dt = parse_timestamp_to_utc_naive(str(t))
    if dt is None:
        raise ValueError(f"bad time format: {t}")

    height = coalesce(raw, ["height", "tx.height"])
    try:
        height = int(height) if height is not None else -1
    except Exception:
        height = -1

    signer = coalesce(raw, ["signer.hash", "signer.address", "signer"], "")
    return BlobRecord(id=blob_id, time=dt, height=height, signer=str(signer))


# ============================== 数据加载 ==============================

def load_from_result_json(path: str) -> List[BlobRecord]:
    blobs_raw: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "blobs" in data and isinstance(data["blobs"], list):
            blobs_raw = data["blobs"]
        elif isinstance(data, list):
            blobs_raw = data
        else:
            print(f"[WARN] {path} 格式不含 'blobs' 列表，尝试作为对象/数组读取。", file=sys.stderr)
            blobs_raw = data.get("items", []) if isinstance(data, dict) else blobs_raw
    except Exception as e:
        print(f"[WARN] 打开 {path} 失败：{e}", file=sys.stderr)
        return []

    out: List[BlobRecord] = []
    for o in blobs_raw:
        try:
            out.append(normalize_record(o))
        except Exception as e:
            print(f"[WARN] 跳过1条记录（{e}）", file=sys.stderr)
    return out


def load_from_data_dir(data_dir: str) -> List[BlobRecord]:
    pattern = os.path.join(data_dir, "blob_batch_*.json")
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"[WARN] 未在 {data_dir} 找到 blob_batch_*.json", file=sys.stderr)
    out: List[BlobRecord] = []
    for fp in files:
        try:
            with open(fp, "r", encoding="utf-8") as f:
                text = f.read()
            for obj in json_fragments_to_list(text):
                try:
                    out.append(normalize_record(obj))
                except Exception as e:
                    print(f"[WARN] 跳过无效记录（{fp}）：{e}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] 读取失败 {fp}：{e}", file=sys.stderr)
    return out


def load_blobs_auto(result_json: str, data_dir: str) -> List[BlobRecord]:
    if result_json and os.path.exists(result_json):
        recs = load_from_result_json(result_json)
        if recs:
            return recs
    # 回退 data_dir
    return load_from_data_dir(data_dir)


# ============================== 统计与检测 ==============================

def compute_gaps(records: List[BlobRecord]) -> Tuple[List[float], List[datetime]]:
    """
    返回：gaps_seconds（list[float]），timestamps_sorted（list[datetime]）
    gaps[i] = timestamps[i] 与 timestamps[i-1] 的差（秒），对应于 timestamps[i]
    """
    if not records:
        return [], []
    recs = sorted(records, key=lambda r: (r.time, r.height))
    ts = [r.time for r in recs]
    if len(ts) < 2:
        return [], ts

    gaps = []
    for i in range(1, len(ts)):
        gaps.append((ts[i] - ts[i-1]).total_seconds())
    return gaps, ts


def analyze_gaps(gaps: List[float], std_k: float = 2.0) -> Dict[str, Any]:
    """
    统计 + 异常（阈值 = mean + std_k * std，与示例保持一致）
    """
    arr = np.asarray(gaps, dtype=float)
    mean_sec = float(np.mean(arr))
    median_sec = float(np.median(arr))
    std_sec = float(np.std(arr))
    thr = mean_sec + std_k * std_sec
    outliers = arr[arr > thr]
    return {
        "total_gaps": int(arr.size),
        "mean_gap_seconds": mean_sec,
        "median_gap_seconds": median_sec,
        "std_gap_seconds": std_sec,
        "outlier_threshold": float(thr),
        "outliers": outliers,
        "outlier_count": int(outliers.size),
        "max_gap_seconds": float(np.max(arr)),
        "min_gap_seconds": float(np.min(arr)),
    }


# ============================== 输出：CSV / 报告 ==============================

def save_proof_list_csv(path: str, records_sorted: List[BlobRecord], gaps: List[float]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "index",
            "prev_time_utc", "next_time_utc",
            "gap_seconds", "gap_minutes", "gap_hours",
            "prev_id", "next_id", "prev_height", "next_height",
            "prev_signer", "next_signer"
        ])
        for i in range(1, len(records_sorted)):
            a, b = records_sorted[i-1], records_sorted[i]
            g = gaps[i-1]
            w.writerow([
                i-1,
                a.time.isoformat(sep=' '), b.time.isoformat(sep=' '),
                f"{g:.6f}", f"{g/60.0:.6f}", f"{g/3600.0:.6f}",
                a.id, b.id, a.height, b.height, a.signer, b.signer
            ])


def generate_report_md(path: str,
                       records: List[BlobRecord],
                       timestamps: List[datetime],
                       gaps: List[float],
                       analysis: Dict[str, Any],
                       namespace_hint: str = "N/A"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    if timestamps:
        first_ts, last_ts = min(timestamps), max(timestamps)
        period_days = (last_ts - first_ts).total_seconds() / 86400.0
    else:
        first_ts = last_ts = None
        period_days = 0.0

    lines = []
    lines.append("# Celestia Blob Posting Consistency Analysis\n")
    lines.append(f"**Analysis Date:** {now} UTC  \n**Namespace:** `{namespace_hint}`\n")
    lines.append("## Executive Summary\n")

    if not gaps:
        lines.append("❌ **Insufficient data** - Need at least 2 blobs to analyze consistency.\n")
    else:
        cv = analysis["std_gap_seconds"] / analysis["mean_gap_seconds"] if analysis["mean_gap_seconds"] > 0 else float("inf")
        if cv < 0.5:
            consistency = "✅ **CONSISTENT** - Low variability in posting intervals"
        elif cv < 1.0:
            consistency = "⚠️ **MODERATELY CONSISTENT** - Some variability in posting intervals"
        else:
            consistency = "❌ **INCONSISTENT** - High variability in posting intervals"
        lines.append(f"{consistency}\n")
        if analysis["outlier_count"] > 0:
            lines.append(f"**{analysis['outlier_count']} significant gaps** detected that are much longer than usual.\n")
        else:
            lines.append("**No significant gaps** detected - posting appears regular.\n")

    lines.append("## Data Overview\n")
    lines.append(f"- **Total Blobs:** {len(records)}")
    lines.append(f"- **Time Gaps Analyzed:** {len(gaps)}")
    lines.append(f"- **Analysis Period:** {period_days:.1f} days\n")
    if timestamps:
        lines.append(f"- **First Blob:** {first_ts.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        lines.append(f"- **Last Blob:** {last_ts.strftime('%Y-%m-%d %H:%M:%S')} UTC\n")

    if gaps:
        lines.append("## Gap Statistics\n")
        lines.append(f"- **Average Gap:** {analysis['mean_gap_seconds']:.0f} s ({analysis['mean_gap_seconds']/3600:.2f} h)")
        lines.append(f"- **Median Gap:** {analysis['median_gap_seconds']:.0f} s ({analysis['median_gap_seconds']/3600:.2f} h)")
        lines.append(f"- **Std Dev:** {analysis['std_gap_seconds']:.0f} s ({analysis['std_gap_seconds']/3600:.2f} h)")
        lines.append(f"- **Shortest Gap:** {analysis['min_gap_seconds']:.0f} s")
        lines.append(f"- **Longest Gap:** {analysis['max_gap_seconds']:.0f} s ({analysis['max_gap_seconds']/3600:.2f} h)\n")

        # 显著间隔表（超过阈值）
        thr = analysis["outlier_threshold"]
        lines.append("## Significant Gaps Identified\n")
        lines.append(f"**Outlier Threshold:** {thr:.0f} s ({thr/3600:.2f} h)\n")
        lines.append("| Gap # | Duration (s) | Hours | Days | Before Time (UTC) | After Time (UTC) |")
        lines.append("|------:|-------------:|------:|-----:|-------------------|------------------|")
        shown = 0
        for i, g in enumerate(gaps, 1):
            if g > thr:
                shown += 1
                bt = timestamps[i-1].strftime("%Y-%m-%d %H:%M:%S")
                at = timestamps[i].strftime("%Y-%m-%d %H:%M:%S")
                lines.append(f"| {i} | {g:.0f} | {g/3600:.1f} | {g/86400:.1f} | {bt} | {at} |")
                if shown >= 15:
                    lines.append(f"\n*… and more ({analysis['outlier_count'] - shown} hidden)*")
                    break

    lines.append("\n## Visual Analysis\n")
    lines.append("![Gaps Over Time](gaps_over_time.png)")
    lines.append("![Gap Distribution](blob_gap_histogram.png)\n")
    lines.append("---\n*Report generated automatically.*\n")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ============================== 绘图 ==============================

def create_time_plot(timestamps: List[datetime],
                     gaps: List[float],
                     analysis: Dict[str, Any],
                     save_path: str):
    """
    生成“随时间的间隔”图（参考示例）：浅蓝折线 + 绿色中位线 + 红色异常点（带标注）+ 左上角摘要框。
    """
    if len(gaps) == 0:
        return

    gaps_h = [g/3600.0 for g in gaps]
    gap_ts = timestamps[1:]  # 间隔对应“后一条”的时间

    plt.figure(figsize=(16, 9))

    # 正常折线
    plt.plot(gap_ts, gaps_h, 'o-', color='lightsteelblue',
             markersize=3, linewidth=1, alpha=0.6, label='Normal gaps')

    # 中位数线
    median_h = analysis["median_gap_seconds"] / 3600.0
    plt.axhline(median_h, color='green', linestyle='-', linewidth=2,
                alpha=0.9, label=f"Median: {median_h:.2f}h")

    # 异常点（> mean + k*std）
    thr = analysis["outlier_threshold"]
    outliers = []
    for i, g in enumerate(gaps):
        if g > thr:
            gh = g / 3600.0
            plt.scatter(gap_ts[i], gh, color='red', s=80, zorder=5,
                        alpha=0.9, edgecolors='darkred', linewidth=1)
            # 注释
            plt.annotate(f"{gh:.1f}h",
                         (gap_ts[i], gh),
                         xytext=(10, 10), textcoords='offset points',
                         bbox=dict(boxstyle='round,pad=0.3', facecolor='red', alpha=0.75),
                         fontsize=9, color='white', weight='bold',
                         arrowprops=dict(arrowstyle='->', connectionstyle='arc3,rad=0'))
            outliers.append((gap_ts[i], gh))

    # 图例中的“Outliers”样例
    if outliers:
        plt.scatter([], [], color='red', s=80, alpha=0.9, edgecolors='darkred',
                    linewidth=1, label=f'Outliers ({len(outliers)} found)')

    # y 轴从 0 开始，顶部留白
    ymax = max(gaps_h) if gaps_h else 1.0
    plt.ylim(bottom=0, top=ymax * 1.1)

    # 摘要框
    summary_text = (
        f"Summary:\n"
        f"• Total gaps analyzed: {len(gaps)}\n"
        f"• Median gap: {median_h:.2f} hours\n"
        f"• Outliers detected: {len(outliers)}\n"
        f"• Largest gap: {ymax:.1f}h"
    )
    plt.text(0.02, 0.98, summary_text, transform=plt.gca().transAxes,
             bbox=dict(boxstyle='round,pad=0.5', facecolor='lightblue', alpha=0.8),
             va='top', fontsize=10, family='monospace')

    # 轴与标题
    ax = plt.gca()
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(ax.xaxis.get_major_locator()))
    plt.xticks(rotation=30)
    plt.xlabel('Date (UTC)', fontsize=12)
    plt.ylabel('Gap Between Blobs (hours)', fontsize=12)
    plt.title('Celestia Blob Posting Gaps Over Time\n(Red dots show abnormally long gaps)', fontsize=14, pad=18)
    plt.grid(True, alpha=0.3, linestyle='--')
    plt.legend(loc='lower right', fontsize=11)
    plt.tight_layout()
    plt.savefig(save_path, dpi=300, bbox_inches='tight', facecolor='white')
    plt.close()


def create_histogram(gaps: List[float], save_path: str):
    """
    直方图（单位：小时），带均值/中位数/95分位参考线；对重尾分布自动切换对数 y 轴。
    """
    if len(gaps) == 0:
        return
    vals = np.array(gaps, dtype=float) / 3600.0

    # Freedman–Diaconis 估计箱数并限制上限
    def fd_bins(x: np.ndarray) -> int:
        if x.size < 2:
            return 10
        q1, q3 = np.percentile(x, [25, 75])
        iqr = q3 - q1
        if iqr <= 0:
            return 50
        h = 2 * iqr * (x.size ** (-1/3))
        if h <= 0:
            return 50
        return max(10, min(200, int(math.ceil((x.max() - x.min()) / h))))

    bins = fd_bins(vals)

    plt.figure(figsize=(12, 7))
    n, b, _ = plt.hist(vals, bins=bins, alpha=0.9)

    # 偏态自动使用对数 y
    p50, p99 = np.percentile(vals, [50, 99])
    if p50 > 0 and (p99 / p50) > 50:
        plt.yscale('log')

    mean = float(np.mean(vals))
    median = float(np.median(vals))
    p95 = float(np.percentile(vals, 95))
    plt.axvline(mean, linestyle='-', linewidth=1.8, label=f"Mean ≈ {mean:.2f}")
    plt.axvline(median, linestyle='--', linewidth=1.8, label=f"Median ≈ {median:.2f}")
    plt.axvline(p95, linestyle=':', linewidth=1.8, label=f"95th pct ≈ {p95:.2f}")

    plt.xlabel("Gap between consecutive blobs (hours)")
    plt.ylabel("Frequency" + (" (log scale)" if plt.gca().get_yscale() == 'log' else ""))
    plt.title("Histogram of Blob Publish Gaps", pad=12)
    plt.grid(True, linestyle='--', linewidth=0.5, alpha=0.7)
    plt.legend()
    plt.tight_layout()
    plt.savefig(save_path, dpi=300, bbox_inches='tight', facecolor='white')
    plt.close()


# ============================== 主流程 ==============================

def main():
    ap = argparse.ArgumentParser(description="Analyze Celestia blob publish gaps and visualize (timeline + histogram).")
    ap.add_argument("--result_json", type=str, default="result.json", help="包含 {'blobs': [...]} 的 JSON 路径")
    ap.add_argument("--data_dir", type=str, default="data", help="备用数据目录（blob_batch_*.json）")
    ap.add_argument("--out_dir", type=str, default="output", help="输出目录")
    ap.add_argument("--std_k", type=float, default=2.0, help="异常阈值 = mean + std_k * std（默认 2.0）")
    ap.add_argument("--namespace", type=str, default="N/A", help="报告中显示的 namespace（可选）")
    args = ap.parse_args()

    # 加载数据（优先 result.json）
    records = load_blobs_auto(args.result_json, args.data_dir)
    if not records:
        print("❌ 未加载到任何 blob 记录。请检查 result.json 或 data 目录。")
        return

    # 计算间隔
    gaps, timestamps = compute_gaps(records)
    if not gaps:
        print("❌ 记录不足（<2）或缺少可解析的时间字段。")
        return

    print(f"Loaded {len(records)} blobs  |  Computed {len(gaps)} gaps")

    # 统计 + 异常
    analysis = analyze_gaps(gaps, std_k=args.std_k)

    # 输出路径
    os.makedirs(args.out_dir, exist_ok=True)
    out_time = os.path.join(args.out_dir, "gaps_over_time.png")
    out_hist = os.path.join(args.out_dir, "blob_gap_histogram.png")
    out_md = os.path.join(args.out_dir, "blob_consistency_report.md")
    out_csv = os.path.join(args.out_dir, "proof_list.csv")

    # 可视化
    print("Drawing timeline plot...")
    create_time_plot(timestamps, gaps, analysis, save_path=out_time)
    print("Drawing histogram...")
    create_histogram(gaps, save_path=out_hist)

    # 证明列表 + 报告
    print("Saving proof list & report...")
    records_sorted = sorted(records, key=lambda r: (r.time, r.height))
    save_proof_list_csv(out_csv, records_sorted, gaps)
    generate_report_md(out_md, records_sorted, timestamps, gaps, analysis, namespace_hint=args.namespace)

    print("✅ Done.")
    print(f"📈 Timeline: {out_time}")
    print(f"📊 Histogram: {out_hist}")
    print(f"📄 Report: {out_md}")
    print(f"🧾 Proof CSV: {out_csv}")
    print(f"Outliers (> mean + {args.std_k}*std): {analysis['outlier_count']}  |  Largest gap: {analysis['max_gap_seconds']/3600:.2f} h")


if __name__ == "__main__":
    main()
