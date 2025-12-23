# Gated Attention for Large Language Models

**Authors:** Zihan Qiu, Zekun Wang, Bo Zheng, Zeyu Huang, Kaiyue Wen, Songlin Yang, Rui Men, Le Yu, Fei Huang, Suozhi Huang, Dayiheng Liu, Jingren Zhou, Junyang Lin (Alibaba Qwen)
**Year:** 2025
**Venue:** NeurIPS 2025 (Best Paper Award, Oral)
**Paper:** https://arxiv.org/abs/2505.06708
**Code:** https://github.com/qiuzh20/gated_attention

## Summary

This podcast episode covers the NeurIPS 2025 Best Paper on gated attention, which introduces a simple but powerful modification to the transformer attention mechanism. By adding a sigmoid gate after the scaled dot-product attention (SDPA), the technique addresses attention sinks, massive activations, and improves training stability, scaling properties, and long-context extrapolation.

## Topics Covered

- The attention sink problem: 47% of attention wasted on first token
- Massive activations and training instability
- The gated attention mechanism: Y' = Y * sigmoid(XW)
- Why non-linearity matters in the value-to-output path
- Sparsity induction through sigmoid saturation
- Systematic comparison of 30 model variants
- Five gating positions (G1-G5) and why G1 wins
- Training stability improvements and higher learning rates
- Better scaling properties at larger model sizes
- Long context extrapolation from 32K to 128K+ tokens
- Real-world deployment in Qwen3-Next (1M token context)
- Comparison with StreamingLLM and other approaches
- Implementation details and computational overhead (<2%)

## Files

- `qiu-2025-gated-attention.m4a` - The audio podcast (35 min)
- `script.md` - Full transcript

## Regenerating

From the repository root:

```bash
cd python

# Preview with macOS TTS (free, fast)
pixi run python generate.py ../public/qiu-2025-gated-attention --preview

# Production with ElevenLabs
export ELEVENLABS_API_KEY="your-api-key"
pixi run python generate.py ../public/qiu-2025-gated-attention

# Normalize audio levels
pixi run python generate.py ../public/qiu-2025-gated-attention --normalize
```

Requires `ffmpeg` for audio processing.
