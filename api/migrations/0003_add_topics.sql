-- Migration: Add topics column for categorization
-- Created: 2024-12-28

-- Add topics as JSON array (SQLite stores as TEXT)
ALTER TABLE episodes ADD COLUMN topics TEXT;

-- Update existing episodes with topics
UPDATE episodes SET topics = '["Inference", "LoRA", "Serving"]' WHERE id = 'punica-2023';
UPDATE episodes SET topics = '["Fine-tuning", "Quantization", "LoRA"]' WHERE id = 'qlora-2023';
UPDATE episodes SET topics = '["Attention", "Architecture", "Qwen"]' WHERE id = 'gated-attention-2025';
UPDATE episodes SET topics = '["Distributed Training", "Infrastructure", "Google"]' WHERE id = 'pathways-2022';
UPDATE episodes SET topics = '["Distributed Training", "Model Parallelism", "NVIDIA"]' WHERE id = 'megatron-lm-2021';
UPDATE episodes SET topics = '["Distributed Training", "Memory Optimization", "PyTorch"]' WHERE id = 'pytorch-fsdp-2023';
UPDATE episodes SET topics = '["Distributed Training", "Memory Optimization", "DeepSpeed"]' WHERE id = 'zero-2020';
