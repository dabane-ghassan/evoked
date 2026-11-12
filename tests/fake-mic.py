#!/usr/bin/env python3
"""A stand-in for the microphone listener: prints loudness lines in gst-launch's format,
25 times a second, reading the current level (in dB) from the file given as argument."""
import sys
import time

path = sys.argv[1]
while True:
    try:
        db = float(open(path).read().strip() or -60)
    except (OSError, ValueError):
        db = -60
    print(f'Got message #1 from element "level0" (element): level, rms=(GValueArray)< {db} >, peak=(GValueArray)< {db} >;', flush=True)
    time.sleep(0.04)
