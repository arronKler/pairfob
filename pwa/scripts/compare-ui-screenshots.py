#!/usr/bin/env python3
"""Compare identically named UI captures and write an offline review artifact.

Run with Python + Pillow, or: uv run --with pillow scripts/compare-ui-screenshots.py
  --baseline DIR --actual DIR --out DIR
Screenshots must use the same browser, viewport, DPR, font, fixture and clock.
"""
import argparse
import base64
import html
import json
from pathlib import Path

from PIL import Image, ImageChops


def inline_image(path):
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f'<img src="data:image/png;base64,{data}" alt="{html.escape(path.name)}">'


def compare(baseline, actual, output):
    expected = sorted(path for path in baseline.glob("*.png") if "hmr-affected" not in path.name)
    if not expected:
        raise ValueError(f"No baseline PNGs in {baseline}")
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for before_path in expected:
        after_path = actual / before_path.name
        result = {"name": before_path.name, "baseline": str(before_path), "actual": str(after_path)}
        if not after_path.exists():
            result.update(status="missing", reason="Actual screenshot is missing")
        else:
            before = Image.open(before_path).convert("RGBA")
            after = Image.open(after_path).convert("RGBA")
            result.update(baseline_size=list(before.size), actual_size=list(after.size))
            if before.size != after.size:
                result.update(status="different", reason="Image dimensions differ")
            else:
                diff = ImageChops.difference(before, after)
                # Alpha must not hide RGB differences in an opaque screenshot.
                bands = diff.split()
                mask = bands[0]
                for band in bands[1:]:
                    mask = ImageChops.lighter(mask, band)
                histogram = mask.histogram()
                changed = sum(histogram[1:])
                result.update(status="identical" if changed == 0 else "different", changed_pixels=changed,
                              total_pixels=before.width * before.height, bounds=mask.getbbox())
                if changed:
                    diff_path = output / f"diff-{before_path.name}"
                    diff.convert("RGB").save(diff_path)
                    result["diff"] = str(diff_path)
        results.append(result)
    known = {path.name for path in expected}
    extra = sorted(path.name for path in actual.glob("*.png") if path.name not in known and "hmr-affected" not in path.name)
    summary = {"baseline": str(baseline), "actual": str(actual), "total": len(results),
               "identical": sum(row["status"] == "identical" for row in results),
               "different": sum(row["status"] == "different" for row in results),
               "missing": sum(row["status"] == "missing" for row in results), "extra": extra, "results": results}
    (output / "comparison.json").write_text(json.dumps(summary, indent=2) + "\n")
    cards = []
    for row in sorted(results, key=lambda item: item["status"] == "identical"):
        passed = row["status"] == "identical"
        label = "Identical" if passed else row.get("reason", f'{row.get("changed_pixels", 0)} changed pixels')
        pictures = f'<figure>{inline_image(Path(row["baseline"]))}<figcaption>Baseline</figcaption></figure>'
        if Path(row["actual"]).exists():
            pictures += f'<figure>{inline_image(Path(row["actual"]))}<figcaption>Actual</figcaption></figure>'
        cards.append(f'<details class="{"pass" if passed else "fail"}" {"" if passed else "open"}>'
                     f'<summary>{html.escape(row["name"])} · {html.escape(label)}</summary><div class="images">{pictures}</div></details>')
    report = f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Pairfob UI comparison</title><style>
body{{font:15px system-ui;margin:32px;background:#0a0c10;color:#e8edf3}}h1{{font-size:25px}}
p{{color:#b2bfce}}details{{border:1px solid #334155;margin:12px 0;border-radius:8px;padding:12px}}
summary{{cursor:pointer}}.pass summary{{color:#8bdfba}}.fail summary{{color:#ffb7aa}}
.images{{display:flex;align-items:flex-start;gap:16px;overflow:auto}}figure{{margin:16px 0;flex:1;min-width:0}}
img{{display:block;width:100%;height:auto}}figcaption{{padding-top:8px;color:#b2bfce}}
</style><h1>Pairfob UI comparison</h1>
<p>{summary["identical"]} / {summary["total"]} exact matches · {summary["different"]} different · {summary["missing"]} missing.</p>
<p>Pixel equality applies only to these captured fixtures. Interaction, production runtime and physical device checks are separate.</p>
{''.join(cards)}'''
    (output / "comparison.html").write_text(report)
    print(json.dumps({key: value for key, value in summary.items() if key != "results"}, indent=2))
    return summary["different"] == 0 and summary["missing"] == 0 and not extra


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--actual", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(0 if compare(args.baseline.resolve(), args.actual.resolve(), args.out.resolve()) else 1)
