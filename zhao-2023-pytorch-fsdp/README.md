# PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel

**Authors:** Yanli Zhao, Andrew Gu, Rohan Varma, Liang Luo, et al. (Meta)
**Year:** 2023
**Venue:** VLDB 2023
**Paper:** https://arxiv.org/abs/2304.11277

## Summary

This podcast episode covers Meta's paper on PyTorch FSDP (Fully Sharded Data Parallel), the native PyTorch implementation of ZeRO-style memory-efficient distributed training. The paper documents the engineering challenges and production experiences of building FSDP into PyTorch.

## Topics Covered

- Why native PyTorch integration matters vs. external libraries
- FSDP fundamentals: sharding parameters, gradients, and optimizer states
- Sharding strategies: FULL_SHARD, SHARD_GRAD_OP, HYBRID_SHARD
- Mixed precision training and numerical stability
- Communication optimization and prefetching
- Memory management and activation checkpointing
- Production experiences at Meta scale
- Comparison with DeepSpeed ZeRO and other approaches
- Best practices and recommendations

## Files

- `podcast.m4a` - The audio podcast (24 min)
- `script.md` - Full transcript
- `generate.py` - Generation script (requires ElevenLabs API key)

## Regenerating

```bash
export ELEVENLABS_API_KEY="your-api-key"
pip install elevenlabs
python generate.py
```

Requires `ffmpeg` for audio processing.
