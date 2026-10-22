"""Serve Kev with its backbone split between the GPU and system RAM.

Run with Kev's own interpreter from the kev checkout, with the same arguments as `python -m kev.serve`:

    KEV_GPU_GB=4 .venv/bin/python /path/to/kev_split.py --run jaredpalmer/kev-4b --port 8009 --device cuda

KEV_GPU_GB is how much of the GPU the backbone may take; accelerate puts the first layers there and the rest in RAM,
moving activations between them on each pass. Unset or 0 serves Kev unchanged. CUDA graphs and fused kernels are off
for a split model: both need every layer on the GPU.
"""
import os
import sys

sys.path.insert(0, os.getcwd())   # the kev checkout; `python script.py` puts only the script's own folder on the path

import torch
from dataclasses import replace

from kev import checkpoint, serve

GPU_GB = float(os.environ.get("KEV_GPU_GB", "0") or 0)
CPU_GB = float(os.environ.get("KEV_CPU_GB", "0") or 0)

_load_torch = checkpoint.Checkpoint._load_torch


def _split_load_torch(self, tok, device, opts):
    if GPU_GB <= 0 or not str(device).startswith("cuda"):
        return _load_torch(self, tok, device, opts)
    from accelerate import dispatch_model, infer_auto_device_map
    # Build on the CPU (in the serving dtype), then place: what fits in GPU_GB on the GPU, the rest in RAM.
    m = _load_torch(self, tok, "cpu", replace(opts, cuda_graphs=False, fused=False, attn=opts.attn or "sdpa"))
    budget = {0: f"{GPU_GB}GiB", "cpu": f"{CPU_GB}GiB" if CPU_GB > 0 else f"{int(_ram_gb() * 0.8)}GiB"}
    layer = type(m.lm.layers[0]).__name__ if hasattr(m.lm, "layers") else None
    device_map = infer_auto_device_map(m.lm, max_memory=budget, no_split_module_classes=[layer] if layer else None)
    on_gpu = sum(1 for d in device_map.values() if d == 0)
    if on_gpu == 0:
        # Not even the embeddings fit: dispatch_model would move the lot without hooks, so serve plainly from RAM.
        print(f"kev_split: nothing fits in {GPU_GB} GiB of GPU; serving from RAM only (raise KEV_GPU_GB)", flush=True)
        return m
    print(f"kev_split: {on_gpu}/{len(device_map)} modules on cuda:0 within {GPU_GB} GiB, the rest in RAM", flush=True)
    m.lm = dispatch_model(m.lm, device_map=device_map, main_device=0)
    m.head.to("cuda")
    m.device = "cuda"
    return m


def _ram_gb():
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (ValueError, OSError):
        return 16.0


checkpoint.Checkpoint._load_torch = _split_load_torch

if __name__ == "__main__":
    serve.main()
