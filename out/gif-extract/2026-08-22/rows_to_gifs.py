"""
Split a 4x4 sprite sheet into 4 row-GIFs (one animation per row).
Each row of `cols` frames becomes one looping GIF.
Usage: python rows_to_gifs.py <input> <out_dir> [--fps 5]
"""
from __future__ import annotations
import argparse
import os
from pathlib import Path
from PIL import Image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--rows", type=int, default=4)
    ap.add_argument("--ms", type=int, default=200, help="frame duration in ms")
    ap.add_argument("--once-rows", type=str, default="",
                    help="comma-separated row indexes that play once (no loop), e.g. '3' for death row")
    args = ap.parse_args()

    once_rows = {int(x) for x in args.once_rows.split(",") if x.strip() != ""}

    img = Image.open(args.input)
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    w, h = img.size
    cw, ch = w // args.cols, h // args.rows
    print(f"image: {w}x{h}  cell: {cw}x{ch}  grid: {args.cols}x{args.rows}")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    for r in range(args.rows):
        frames = []
        for c in range(args.cols):
            box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
            frames.append(img.crop(box))

        plays_once = r in once_rows
        gif_path = args.out_dir / f"row{r}.gif"
        if plays_once:
            # play once, hold last frame for a long beat
            durations = [args.ms] * (len(frames) - 1) + [max(args.ms * 10, 2000)]
            frames[0].save(
                gif_path, save_all=True, append_images=frames[1:],
                duration=durations, loop=1, disposal=2, optimize=False,
            )
        else:
            frames[0].save(
                gif_path, save_all=True, append_images=frames[1:],
                duration=args.ms, loop=0, disposal=2, optimize=False,
            )
        kind = "once" if plays_once else "loop"
        print(f"  row{r}  {kind}  {len(frames)} frames @ {args.ms}ms  -> {gif_path} ({os.path.getsize(gif_path)} bytes)")


if __name__ == "__main__":
    main()
