# ZeRO: Memory Optimizations Toward Training Trillion Parameter Models

**Authors:** Samyam Rajbhandari, Jeff Rasley, Olatunji Ruwase, Yuxiong He (Microsoft Research)
**Year:** 2020
**Venue:** SC20 (International Conference for High Performance Computing)
**Paper:** https://arxiv.org/abs/1910.02054

## Summary

This podcast episode covers Microsoft's ZeRO paper, which introduced memory-efficient distributed training techniques that enabled training trillion-parameter models. ZeRO eliminates memory redundancy in data parallelism by partitioning optimizer states, gradients, and parameters across GPUs.

## Topics Covered

- The memory problem in training large models
- Data parallelism vs model parallelism limitations
- ZeRO's key insight: eliminating redundancy
- ZeRO Stage 1, 2, and 3 explained
- Communication primitives (all-reduce, reduce-scatter, all-gather)
- Mathematical analysis of memory savings
- DeepSpeed implementation
- Experimental results and scaling
- Impact and legacy (FSDP, ZeRO-Offload, ZeRO-Infinity)

## Files

- `rajbhandari-2020-zero.m4a` - The audio podcast (17 min)
- `script.md` - Full transcript

## Regenerating

From the repository root:

```bash
export ELEVENLABS_API_KEY="your-api-key"
pip install -r python/requirements.txt
python python/generate.py public/rajbhandari-2020-zero
```

Requires `ffmpeg` for audio processing.
