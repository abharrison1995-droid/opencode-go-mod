"""Tests for kev_split.py, with stand-ins for torch, kev and accelerate, so they need neither a GPU nor Kev's venv.

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import importlib.util
import os
import sys
import types
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent


@dataclass
class Opts:
    attn: str | None = None
    cuda_graphs: bool | None = None
    fused: bool | None = None


class Layer:
    pass


class Model:
    def __init__(self):
        self.lm = types.SimpleNamespace(layers=[Layer()])
        self.head = mock.Mock()
        self.device = "cpu"


def load(env, device_map=None):
    """Imports kev_split afresh under `env`, with the stand-ins; returns it, the original loader and accelerate."""
    calls = []

    def original(self, tok, device, opts):
        calls.append((device, opts))
        return Model()

    checkpoint = types.ModuleType("kev.checkpoint")
    checkpoint.Checkpoint = type("Checkpoint", (), {"_load_torch": original})
    kev = types.ModuleType("kev")
    kev.checkpoint = checkpoint
    kev.serve = types.ModuleType("kev.serve")
    accelerate = types.ModuleType("accelerate")
    accelerate.infer_auto_device_map = mock.Mock(return_value=device_map if device_map is not None else {"embed": 0, "layers.0": 0, "layers.1": "cpu"})
    accelerate.dispatch_model = mock.Mock(side_effect=lambda lm, **_: lm)
    modules = {"torch": types.ModuleType("torch"), "kev": kev, "kev.checkpoint": checkpoint, "kev.serve": kev.serve, "accelerate": accelerate}

    spec = importlib.util.spec_from_file_location("kev_split", HERE / "kev_split.py")
    split = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, modules), mock.patch.dict(os.environ, env, clear=False):
        spec.loader.exec_module(split)
    return split, checkpoint.Checkpoint, calls, accelerate


def run(split, checkpoint, accelerate, device, opts=None):
    with mock.patch.dict(sys.modules, {"accelerate": accelerate}):
        return checkpoint._load_torch(checkpoint(), "tok", device, opts or Opts())


class KevSplitTest(unittest.TestCase):
    def test_patches_the_loader(self):
        split, checkpoint, _, _ = load({"KEV_GPU_GB": "4"})
        self.assertIs(checkpoint._load_torch, split._split_load_torch)

    def test_unset_or_zero_serves_kev_unchanged(self):
        for env in ({"KEV_GPU_GB": ""}, {"KEV_GPU_GB": "0"}):
            split, checkpoint, calls, accelerate = load(env)
            opts = Opts(cuda_graphs=True)
            run(split, checkpoint, accelerate, "cuda", opts)
            self.assertEqual(calls, [("cuda", opts)])
            accelerate.dispatch_model.assert_not_called()

    def test_a_cpu_device_is_not_split(self):
        split, checkpoint, calls, accelerate = load({"KEV_GPU_GB": "4"})
        run(split, checkpoint, accelerate, "cpu")
        self.assertEqual(calls[0][0], "cpu")
        accelerate.infer_auto_device_map.assert_not_called()

    def test_splits_within_the_gpu_budget(self):
        split, checkpoint, calls, accelerate = load({"KEV_GPU_GB": "4", "KEV_CPU_GB": "20"})
        m = run(split, checkpoint, accelerate, "cuda:0", Opts(cuda_graphs=True, fused=True))
        device, opts = calls[0]
        # Built on the CPU, without the kernels that need every layer on the GPU.
        self.assertEqual(device, "cpu")
        self.assertEqual(opts, Opts(attn="sdpa", cuda_graphs=False, fused=False))
        _, kwargs = accelerate.infer_auto_device_map.call_args
        self.assertEqual(kwargs["max_memory"], {0: "4.0GiB", "cpu": "20.0GiB"})
        self.assertEqual(kwargs["no_split_module_classes"], ["Layer"])
        accelerate.dispatch_model.assert_called_once()
        self.assertEqual(accelerate.dispatch_model.call_args.kwargs["main_device"], 0)
        m.head.to.assert_called_once_with("cuda")
        self.assertEqual(m.device, "cuda")

    def test_keeps_an_attention_backend_that_was_asked_for(self):
        split, checkpoint, calls, accelerate = load({"KEV_GPU_GB": "4"})
        run(split, checkpoint, accelerate, "cuda", Opts(attn="eager"))
        self.assertEqual(calls[0][1].attn, "eager")

    def test_ram_budget_defaults_to_most_of_the_ram(self):
        split, checkpoint, _, accelerate = load({"KEV_GPU_GB": "2", "KEV_CPU_GB": ""})
        with mock.patch.object(split, "_ram_gb", return_value=40.0):
            run(split, checkpoint, accelerate, "cuda")
        self.assertEqual(accelerate.infer_auto_device_map.call_args.kwargs["max_memory"]["cpu"], "32GiB")

    def test_nothing_on_the_gpu_serves_from_ram(self):
        split, checkpoint, _, accelerate = load({"KEV_GPU_GB": "0.1"}, device_map={"embed": "cpu", "layers.0": "cpu"})
        m = run(split, checkpoint, accelerate, "cuda")
        accelerate.dispatch_model.assert_not_called()
        m.head.to.assert_not_called()
        self.assertEqual(m.device, "cpu")

    def test_ram_size_falls_back_when_unknown(self):
        split, _, _, _ = load({})
        with mock.patch.object(split.os, "sysconf", side_effect=ValueError):
            self.assertEqual(split._ram_gb(), 16.0)


if __name__ == "__main__":
    unittest.main()
