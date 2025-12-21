# Deep Dive: PyTorch FSDP - Experiences on Scaling Fully Sharded Data Parallel

**Podcast Duration:** ~30 minutes
**Hosts:** Alex Chen (AI researcher) & Maya Rodriguez (ML engineer)
**Format:** Conversational technical deep-dive

---

## [INTRO - 0:00]

**ALEX:** Welcome back to "Gradient Descent," the podcast where we break down the papers that shaped modern machine learning. I'm Alex Chen.

**MAYA:** And I'm Maya Rodriguez. Today we're covering a paper that's near and dear to anyone who's trained large models in PyTorch—the PyTorch FSDP paper, officially titled "PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel."

**ALEX:** This paper comes from the PyTorch team at Meta, and it documents their journey building FSDP directly into PyTorch. The authors include Yanli Zhao, Andrew Gu, Rohan Varma, Liang Luo, and several others from Meta's infrastructure teams.

**MAYA:** What I love about this paper is that it's not just about the algorithm—it's about the real-world engineering challenges of making distributed training work at scale. They share war stories from production, which is rare and incredibly valuable.

**ALEX:** Right. If you remember our episode on ZeRO, FSDP is essentially PyTorch's native implementation of those ideas. But as we'll see, taking a great idea and making it production-ready in a major framework involves a lot of subtle engineering decisions.

**MAYA:** Let's set the stage. It's around 2021-2022, and the demand for training ever-larger models is exploding. GPT-3 had just demonstrated what 175 billion parameters could do, and everyone wanted to train their own large models.

**ALEX:** PyTorch was already the dominant framework in research and increasingly in production. Companies and researchers loved its flexibility and Pythonic design. But PyTorch's existing solution for distributed training had a fundamental limitation.

**MAYA:** DistributedDataParallel, or DDP—PyTorch's workhorse for distributed training—replicates the entire model on every GPU.

**ALEX:** And as we discussed in the ZeRO episode, that means you simply cannot train models larger than what fits in a single GPU's memory. If your model needs 40 gigabytes and your GPU has 32, you're stuck.

**MAYA:** DeepSpeed had solved this problem with their ZeRO optimizer. But DeepSpeed is a separate library built on top of PyTorch. Meta wanted this capability built natively into PyTorch itself, and that's what FSDP is.

---

## [SEGMENT 1: THE CASE FOR NATIVE INTEGRATION - 4:00]

**ALEX:** Let's dig into why it matters whether this functionality is built into PyTorch versus being a separate library. Some might say, "DeepSpeed works, why reinvent the wheel?"

**MAYA:** Great question, and the paper addresses this directly. There are several compelling reasons for native integration.

**ALEX:** Walk us through them.

**MAYA:** First and most practically, there's the maintenance burden. PyTorch evolves rapidly. Every few months there's a new version with new features, new backends, new hardware support, changes to internal APIs. An external library has to constantly chase these changes.

**ALEX:** I've personally experienced this pain. You upgrade PyTorch for some new feature, and suddenly your training code breaks because DeepSpeed hasn't caught up yet.

**MAYA:** Exactly. With a native solution, FSDP evolves with the framework. When PyTorch adds a new feature, the team can ensure FSDP works with it from day one.

**ALEX:** What about the technical advantages of being inside the framework?

**MAYA:** This is where it gets really interesting. When you're part of PyTorch, you can hook into internal APIs that external libraries simply cannot access. You can make optimizations that require deep coordination with the autograd engine, the memory allocator, the CUDA stream management.

**ALEX:** Give me a concrete example.

**MAYA:** Okay, consider parameter gathering during the backward pass. FSDP needs to know exactly when each layer's backward computation is about to start so it can pre-fetch the parameters. Inside PyTorch, they can register hooks directly with the autograd engine that fire at precisely the right moment. An external library has to use cruder approximations.

**ALEX:** The paper mentions integration with PyTorch's memory allocator too.

**MAYA:** Yes. PyTorch has a sophisticated caching CUDA allocator that pools memory to reduce allocation overhead. FSDP can coordinate with this allocator to reserve memory for parameter buffers efficiently. An external library would be fighting with PyTorch for memory, not cooperating with it.

**ALEX:** And there's the user experience angle.

**MAYA:** Huge. If FSDP is part of PyTorch, users get it with their normal pip install. No separate package to manage, no version compatibility matrix to navigate. The documentation is integrated. The error messages understand the full stack.

**ALEX:** That last point about error messages is underrated. Debugging distributed training is already hard enough.

**MAYA:** So hard. And when something goes wrong in the boundary between PyTorch and an external library, the error messages are often useless because neither system has full visibility into what happened.

---

## [SEGMENT 2: FSDP FUNDAMENTALS AND DESIGN - 7:30]

**ALEX:** Let's get into how FSDP actually works. At its core, what's the basic idea?

**MAYA:** FSDP shards model parameters, gradients, and optimizer states across data parallel workers—just like ZeRO Stage 3. Each GPU only stores a fraction of the full model state at rest.

**ALEX:** Walk us through the lifecycle of a training step.

**MAYA:** Okay, let's say you have a model and 8 GPUs. In regular data parallelism with DDP, every GPU has a complete copy of all parameters, all gradients, all optimizer states. With FSDP, each GPU stores only one-eighth of everything.

**ALEX:** So GPU zero might have layers one through four, GPU one has layers five through eight, and so on?

**MAYA:** Actually, it's more fine-grained than that. The sharding is typically at the parameter level within an FSDP unit, not the layer level. But the key point is that no single GPU has everything.

**ALEX:** But you need all the parameters to actually compute the forward pass.

**MAYA:** Right, so here's what happens. When you're about to compute a layer, FSDP runs an all-gather operation. All 8 GPUs send their shards to all other GPUs, and every GPU reconstructs the full parameters for that layer.

**ALEX:** That sounds like a lot of communication.

**MAYA:** It is. But here's the key: you do it just-in-time for each layer, compute the forward pass, and then you can throw away the parameters you're not responsible for. Peak memory is much lower than keeping everything resident.

**ALEX:** And in the backward pass?

**MAYA:** Similar pattern. You gather parameters when needed for gradient computation, compute the gradients, and then use a reduce-scatter operation to distribute gradients to their owners. Each GPU ends up with only the gradients for its parameter shard.

**ALEX:** The paper introduces this concept of FSDP units. Explain that.

**MAYA:** This is a crucial design decision. FSDP doesn't shard at the individual parameter level—every single weight matrix as its own unit. That would be far too fine-grained and create enormous communication overhead.

**ALEX:** So what's the granularity?

**MAYA:** You wrap portions of your model into FSDP units, and each unit is gathered and freed as a whole. For transformers, the natural choice is one FSDP unit per transformer block. Each block has its attention layers and feed-forward layers wrapped together.

**ALEX:** That makes the gather and free operations more efficient.

**MAYA:** Much more. Larger communication chunks use network bandwidth more efficiently. There's also less synchronization overhead when you have fewer, larger operations versus many tiny ones.

**ALEX:** Is there a tradeoff?

**MAYA:** Absolutely. Larger FSDP units mean higher peak memory because you're gathering more parameters at once. Smaller units mean more communication operations but lower peak memory. The paper discusses how to navigate this tradeoff.

---

## [SEGMENT 3: SHARDING STRATEGIES DEEP DIVE - 11:30]

**ALEX:** One of the paper's contributions is formalizing different sharding strategies. This goes beyond the simple "shard everything" approach.

**MAYA:** Yes, FSDP supports multiple strategies that give users control over the memory-communication tradeoff. The main strategies are FULL_SHARD, SHARD_GRAD_OP, NO_SHARD, and HYBRID_SHARD.

**ALEX:** Let's go through each one systematically.

**MAYA:** FULL_SHARD is the complete ZeRO Stage 3 equivalent. Parameters are sharded at rest, gathered on-demand for computation, and freed after. Gradients are sharded via reduce-scatter. Optimizer states are sharded. Maximum memory efficiency.

**ALEX:** When would you use this?

**MAYA:** When your model doesn't fit any other way. If you have a 100 billion parameter model and need to squeeze it onto your GPUs, FULL_SHARD is your tool. The communication overhead is highest, but you have no choice.

**ALEX:** What about SHARD_GRAD_OP?

**MAYA:** This is similar to ZeRO Stage 2. Parameters stay fully gathered during the forward and backward passes—you pay the memory cost of a full copy of parameters. But gradients and optimizer states are still sharded.

**ALEX:** Less communication because you're not gathering parameters.

**MAYA:** Right. After the backward pass, each GPU does a reduce-scatter on gradients instead of a full all-reduce. You get sharded gradients and optimizer states, but parameter memory is replicated.

**ALEX:** So it's a middle ground.

**MAYA:** Exactly. If your model almost fits in memory with DDP but not quite, SHARD_GRAD_OP might be perfect. You get meaningful memory savings with less communication overhead than FULL_SHARD.

**ALEX:** And NO_SHARD?

**MAYA:** This is basically DDP wrapped in FSDP's API. Full replication of everything. Useful when you want to mix FSDP and non-FSDP components, or when you're migrating code gradually.

**ALEX:** Now HYBRID_SHARD is the interesting one.

**MAYA:** Very interesting, and probably the most practical for real-world clusters. HYBRID_SHARD does full sharding within a node but data parallel replication across nodes.

**ALEX:** Explain why that's useful.

**MAYA:** Consider a typical cluster. Within a node, you have 8 GPUs connected by NVLink with 600 gigabytes per second of bandwidth. Between nodes, you have InfiniBand at maybe 200 gigabytes per second, shared across all 8 GPUs.

**ALEX:** So intra-node communication is much faster.

**MAYA:** Much faster. HYBRID_SHARD exploits this. The 8 GPUs in a node fully shard among themselves—lots of communication, but it's fast NVLink. Then you replicate across nodes, so cross-node traffic is just gradient averaging, not parameter gathering.

**ALEX:** The paper shows this can be significantly faster.

**MAYA:** In some configurations, 20-30% faster than FULL_SHARD across all nodes. It's a practical optimization that reflects how real clusters are built.

---

## [SEGMENT 4: MIXED PRECISION AND NUMERICAL CONSIDERATIONS - 15:30]

**ALEX:** Let's talk about mixed precision training, which is essential for efficiency at this scale.

**MAYA:** Absolutely essential. You basically can't train large models efficiently without mixed precision. The memory savings and compute speedup are too significant to leave on the table.

**ALEX:** Explain the basics for listeners who might not be familiar.

**MAYA:** Standard floating point numbers in deep learning use 32 bits—float32. Mixed precision uses 16-bit floats for most computation—either float16 or bfloat16—but keeps 32-bit for critical operations.

**ALEX:** Why is 16-bit safe for some operations but not others?

**MAYA:** 16-bit has less numerical range and precision. For forward and backward computation, this is usually fine—the numbers are in a reasonable range. But optimizer updates involve accumulating many small gradient values over time. In 16-bit, these small updates get rounded to zero.

**ALEX:** So optimizer states stay in 32-bit.

**MAYA:** Right. The paper discusses FSDP's mixed precision design in detail. They have three configurable precision settings: the parameter precision at rest, the reduce precision for gradient communication, and buffer precision for internal storage.

**ALEX:** Why do you need this granularity?

**MAYA:** Different operations have different sensitivity. You might want parameters stored in float16 for memory savings, but you might want gradient reduction in float32 to avoid precision loss in the averaging. The flexibility lets you tune for your specific model and hardware.

**ALEX:** The paper mentions bfloat16 specifically.

**MAYA:** Yes. Bfloat16 is increasingly preferred over float16. It has the same memory footprint but different numerical properties—same exponent range as float32, just less mantissa precision. This means fewer overflow and underflow issues.

**ALEX:** Modern hardware like A100s and H100s have good bfloat16 support.

**MAYA:** Excellent support. If you're on hardware that supports bfloat16, the paper recommends using it. You get the memory and compute benefits of 16-bit with better numerical stability.

**ALEX:** The paper also discusses loss scaling for float16.

**MAYA:** When using float16, gradients can underflow—become so small they round to zero. Loss scaling multiplies the loss by a large number before backprop, making gradients bigger, then scales them back down. FSDP integrates with PyTorch's automatic loss scaler.

---

## [SEGMENT 5: COMMUNICATION OPTIMIZATION - 19:00]

**ALEX:** Communication is obviously central to FSDP's performance. The paper goes deep on optimization strategies here.

**MAYA:** Yes, because communication can easily become the bottleneck. Modern GPUs are so fast that they're often waiting on data to arrive from the network.

**ALEX:** What's the main optimization technique?

**MAYA:** Overlapping communication with computation. The idea is simple: while the GPU is computing layer N's forward pass, start gathering layer N+1's parameters. When layer N finishes, layer N+1's parameters are already there.

**ALEX:** Pipelining the communication.

**MAYA:** Exactly. Modern GPUs have separate engines for compute and communication. They can run simultaneously. If you structure your execution right, communication is almost entirely hidden behind computation.

**ALEX:** The paper mentions this is tricky to get right.

**MAYA:** Very tricky. Naive prefetching can backfire. If you prefetch too aggressively, you fill up memory with parameters you don't need yet, and you might starve computation of memory bandwidth for activations.

**ALEX:** They mention rate limiting.

**MAYA:** Yes. FSDP has configurable rate limiting for prefetch. You can control how many FSDP units ahead to prefetch. The optimal setting depends on model architecture, batch size, GPU memory, network speed—lots of variables.

**ALEX:** Backward pass prefetching is also mentioned.

**MAYA:** Same idea. During backprop, you can prefetch the previous layer's parameters while computing the current layer's gradients. This is actually called "backward prefetching" in the codebase.

**ALEX:** The paper discusses bucketing for gradient reduction too.

**MAYA:** Yes, borrowed from DDP. Instead of reducing each parameter's gradients individually—which would have high per-operation overhead—you bucket many gradients together and reduce as a chunk.

**ALEX:** Amortizing the fixed costs.

**MAYA:** Right. Each communication call has setup overhead—launching CUDA kernels, network latency. If you're sending a megabyte instead of a kilobyte, that overhead is amortized over a thousand times more data.

---

## [SEGMENT 6: MEMORY MANAGEMENT DEEP DIVE - 22:30]

**ALEX:** Memory management in FSDP is complex and critical. The whole point is memory efficiency, so getting this wrong defeats the purpose.

**MAYA:** Absolutely. The paper dedicates significant attention to memory because it's so central to FSDP's value proposition. Let me explain the challenges.

**ALEX:** What makes it challenging?

**MAYA:** In the gather-compute-free pattern, you're constantly allocating large parameter buffers, using them briefly, then freeing them. This happens for every FSDP unit, every forward and backward pass.

**ALEX:** And CUDA memory allocation isn't free.

**MAYA:** Not at all. The default CUDA allocator talks to the GPU driver for every allocation. That's slow. And with repeated allocate-free cycles, you get fragmentation—you have enough total free memory, but it's scattered in small chunks.

**ALEX:** How does FSDP address this?

**MAYA:** By leveraging PyTorch's caching allocator. Instead of returning memory to the CUDA driver, PyTorch keeps freed blocks in a cache. Next allocation can reuse cached blocks instantly.

**ALEX:** But you need the right block sizes.

**MAYA:** Exactly. If your parameter buffer needs 500 megabytes and the largest cached block is 400 megabytes, you have a problem. FSDP tries to allocate consistently sized buffers so the cache works well.

**ALEX:** The paper discusses memory budgets.

**MAYA:** Yes. You can configure how much memory FSDP is allowed to use for prefetching and buffering. If you set a tight budget, FSDP prefetches less aggressively. If you have memory headroom, you can prefetch more for better communication overlap.

**ALEX:** There's also discussion of activation memory.

**MAYA:** Right. FSDP shards model states, but activation memory is a separate concern. During forward pass, you store activations for the backward pass. For large models with big batch sizes, activations can be bigger than model parameters.

**ALEX:** Activation checkpointing helps here.

**MAYA:** It's almost required for very large models. Instead of storing all activations, you checkpoint at layer boundaries. During backward pass, you recompute activations. Trade compute for memory.

**ALEX:** The paper shows FSDP works well with activation checkpointing.

**MAYA:** They designed it to integrate smoothly. You can wrap transformer layers with both FSDP and activation checkpointing, and they compose correctly.

---

## [SEGMENT 7: PRODUCTION EXPERIENCES - 26:00]

**ALEX:** What I find most valuable in this paper is the production experiences section. You rarely see this level of detail about deploying at scale.

**MAYA:** It's genuinely rare. Most papers stop at "our experiments showed good results on this benchmark." This paper says "here's what actually happened when we ran this in production for months."

**ALEX:** What were the main categories of challenges?

**MAYA:** I'd group them into: numerical stability, debugging at scale, infrastructure integration, and operational concerns. Let me go through each.

**ALEX:** Start with numerical stability.

**MAYA:** Large models are surprisingly sensitive to numerical precision. Operations that work fine in small models can cause NaNs or divergence at billion-parameter scale.

**ALEX:** Specific examples?

**MAYA:** They mention layer normalization and attention softmax. The statistics computed in layer norm can overflow or lose precision in float16. Softmax can have numerical issues with very large or small inputs. These issues might not manifest until you're training for days.

**ALEX:** How do you debug when training fails after three days?

**MAYA:** That's exactly the challenge. They built tooling to identify which rank first produced a NaN, to check synchronization across workers, to detect divergence early. Distributed debugging is its own discipline.

**ALEX:** What about infrastructure integration?

**MAYA:** Meta has a massive internal ecosystem. Custom hardware, specialized networking, internal training frameworks built on PyTorch. FSDP had to work with all of it.

**ALEX:** Checkpointing seems like a big deal at this scale.

**MAYA:** Huge. For a trillion-parameter model, you can't just gather all parameters to one GPU and write them out—that would require more memory than any GPU has. FSDP supports distributed checkpointing where each rank writes its shard independently.

**ALEX:** Resuming from checkpoints?

**MAYA:** Also complex. If you saved with 128 GPUs and want to resume with 256, the shards don't map directly. They developed resharding capabilities for flexible checkpoint handling.

---

## [SEGMENT 8: SCALING EXPERIMENTS AND BENCHMARKS - 29:00]

**ALEX:** The paper has extensive experimental results. Let's talk about what they actually measured.

**MAYA:** They ran experiments on models ranging from 7 billion to over 1 trillion parameters, across clusters with up to 512 GPUs. Very comprehensive testing.

**ALEX:** What were the headline results?

**MAYA:** For large models, FSDP achieves near-linear scaling. A 175 billion parameter model going from 128 to 512 GPUs shows almost 4x throughput improvement. That's close to ideal.

**ALEX:** Any surprises in the benchmarks?

**MAYA:** One interesting finding: for models that fit in memory without sharding, DDP is still faster. The overhead of gathering and freeing parameters is real. FSDP wins on capability, not raw speed for small models.

**ALEX:** Makes sense—there's no free lunch.

**MAYA:** Right. But for the models FSDP targets—ones that don't fit in DDP—the comparison isn't speed, it's "possible versus impossible." That's a different conversation entirely.

**ALEX:** How does FSDP compare to DeepSpeed ZeRO?

**MAYA:** They show FSDP is competitive, sometimes faster. For certain configurations, FSDP's deeper integration with PyTorch allows optimizations that external libraries can't match.

**ALEX:** Any specific examples?

**MAYA:** The prefetching and memory management integration I mentioned earlier. When you're inside PyTorch, you can coordinate with the CUDA stream scheduler and memory allocator in ways that improve efficiency. DeepSpeed has to work around these systems.

**ALEX:** What about the HYBRID_SHARD results specifically?

**MAYA:** Very compelling. On a 64-node cluster with 8 GPUs per node, HYBRID_SHARD was 25% faster than FULL_SHARD for a 70 billion parameter model. That's a significant win for a simple configuration change.

**ALEX:** Because you're not sending parameters across the slow inter-node network.

**MAYA:** Exactly. You're exploiting the hardware topology. Fast NVLink within nodes, minimize traffic across InfiniBand between nodes. It's practical systems thinking.

---

## [SEGMENT 9: COMPARISON WITH ALTERNATIVES - 32:30]

**ALEX:** Let's contextualize FSDP against the broader landscape. What are the alternatives?

**MAYA:** The main alternatives are DeepSpeed ZeRO, which we've discussed, Megatron-LM's tensor parallelism, and various pipeline parallelism approaches.

**ALEX:** How does FSDP compare to tensor parallelism?

**MAYA:** They're complementary, not competing. Tensor parallelism splits individual operations—like a big matrix multiply—across GPUs. FSDP shards stored state but does full operations on each GPU after gathering.

**ALEX:** So you could use both together?

**MAYA:** Absolutely, and that's how the largest models are trained. You might use tensor parallelism within a node—splitting operations across 8 GPUs with fast NVLink—and FSDP across nodes for memory efficiency.

**ALEX:** The paper mentions this hybrid approach.

**MAYA:** Yes. They call it 2D parallelism or sometimes 3D parallelism if you add pipeline stages. The largest production models—think GPT-4 scale—use multiple forms of parallelism together.

**ALEX:** What's the advantage of FSDP over pipeline parallelism?

**MAYA:** Pipeline parallelism has the bubble problem. GPUs sit idle waiting for activations or gradients from other stages. FSDP keeps all GPUs busy because they're all doing the same computation on different data.

**ALEX:** But pipeline parallelism uses less communication?

**MAYA:** Yes, there's a tradeoff. Pipeline only sends activations and gradients between adjacent stages. FSDP does all-gathers of full parameter buffers. For some model architectures and cluster topologies, pipeline wins.

**ALEX:** How do practitioners choose?

**MAYA:** It depends on model size, cluster topology, and what bottleneck you're hitting. If you're memory-bound, FSDP helps. If you're communication-bound, pipeline might be better. Often you need to experiment.

---

## [SEGMENT 10: BEST PRACTICES AND RECOMMENDATIONS - 36:00]

**ALEX:** Let's synthesize the practical guidance from this paper. What should practitioners know?

**MAYA:** Several key recommendations. First, wrap your model at the right granularity. For transformers, each transformer block should be an FSDP unit. Don't go finer-grained unless you have a specific reason.

**ALEX:** What about choosing a sharding strategy?

**MAYA:** Start with FULL_SHARD if you're memory constrained—and you probably are if you're using FSDP at all. If you have a multi-node cluster, definitely try HYBRID_SHARD; it's often faster.

**ALEX:** Mixed precision?

**MAYA:** Use bfloat16 if your hardware supports it. It's just better behaved numerically with the same memory benefits. Always monitor for numerical issues, especially early in training when gradients can be large.

**ALEX:** Any communication tuning advice?

**MAYA:** Enable prefetching for both forward and backward passes. Start with the default rate limits and tune from there. Monitor GPU utilization—if your GPUs are frequently idle, you might have communication bottlenecks.

**ALEX:** What about interaction with other techniques?

**MAYA:** Activation checkpointing is almost mandatory for very large models. It composes well with FSDP. If you need even more memory efficiency, look at gradient checkpointing and offloading to CPU memory.

**ALEX:** Any common mistakes to avoid?

**MAYA:** A few. Don't wrap too fine-grained—wrapping every linear layer separately creates massive overhead. Don't forget to use gradient clipping—large models can have exploding gradients. And definitely test your checkpointing before running a long job.

**ALEX:** That last one sounds like bitter experience.

**MAYA:** It's a common failure mode. You train for two days, try to checkpoint, and something fails. Now you've lost two days of compute. Always validate your checkpoint and restore logic upfront.

---

## [OUTRO - 39:00]

**ALEX:** Any final thoughts on this paper?

**MAYA:** It's a masterclass in production ML systems engineering. The core algorithm isn't novel—it's ZeRO—but the implementation and integration work is substantial and valuable.

**ALEX:** What's the broader lesson?

**MAYA:** That systems work matters enormously. The best algorithm is useless if it's not reliable, debuggable, and maintainable at scale. FSDP succeeds because the team sweated all those unglamorous details.

**ALEX:** Who should read this paper?

**MAYA:** Anyone training models in PyTorch that don't fit on a single GPU. So increasingly, everyone doing serious ML work. Even if you use the default settings, understanding what's happening under the hood makes you a better practitioner.

**ALEX:** That's going to do it for today's episode of Gradient Descent. Thanks for listening, everyone.

**MAYA:** If you enjoyed this deep dive, subscribe and let us know what papers you want us to cover next. Find us on Twitter at gradient underscore pod.

**ALEX:** Until next time, keep training.

**MAYA:** And may your gradients never explode.

**ALEX:** Still a terrible sign-off.

**MAYA:** Still keeping it.

---

## REFERENCES

- Zhao, Y., Gu, A., Varma, R., Luo, L., et al. (2023). PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel. VLDB 2023.

- Paper available at: https://arxiv.org/abs/2304.11277

- PyTorch FSDP documentation: https://pytorch.org/docs/stable/fsdp.html

---

*Total runtime: Approximately 30-32 minutes at conversational pace*
*Word count: ~7,800 words*
