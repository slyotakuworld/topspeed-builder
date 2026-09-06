"""
Slice a 4x4 sprite sheet into 16 frames and assemble a GIF.
Usage: python split_sheet_to_gif.py <input.jpg> <output_dir> [--fps 8]
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
    ap.add_argument("--fps", type=int, default=8, help="frames per second")
    ap.add_argument("--loop", type=int, default=0, help="0 = infinite")
    args = ap.parse_args()

    img = Image.open(args.input)
    # keep RGBA so transparency survives in the GIF
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    w, h = img.size
    cw, ch = w // args.cols, h // args.rows
    print(f"image: {w}x{h}  cell: {cw}x{ch}  grid: {args.cols}x{args.rows}")

    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)
    frames_dir = out / "frames"
    frames_dir.mkdir(exist_ok=True)

    frames: list[Image.Image] = []
    for r in range(args.rows):
        for c in range(args.cols):
            box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
            tile = img.crop(box)
            idx = r * args.cols + c
            tile.save(frames_dir / f"frame_{idx:02d}_r{r}c{c}.png")
            frames.append(tile)
            print(f"  frame {idx:02d}  r={r} c={c}  box={box}")

    duration_ms = int(round(1000 / args.fps))
    gif_path = out / "animation.gif"
    # Pillow >= 9.1 prefers disposal=2 for clean per-frame transparency
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=args.loop,
        disposal=2,
        optimize=False,
    )
    print(f"GIF written: {gif_path}  size={os.path.getsize(gif_path)} bytes  duration={duration_ms}ms/frame")


if __name__ == "__main__":
    main()
