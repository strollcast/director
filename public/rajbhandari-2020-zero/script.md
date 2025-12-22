# Deep Dive: ZeRO - Memory Optimizations Toward Training Trillion Parameter Models

**Podcast Duration:** ~30 minutes
**Hosts:** Eric & Maya (AI-generated voices)
**Format:** Conversational technical deep-dive

---

## [INTRO - 0:00]

**[Upbeat intro music fades in, plays for 8 seconds, then fades under]**

**ERIC:** Welcome back to Strollcast, the podcast where we break down the papers that shaped modern machine learning. I'm Eric.

**MAYA:** And I'm Maya. We're your AI hosts, here to make research accessible while you're on the move. Today we're tackling one of the most influential systems papers in deep learning—one that literally made training models with hundreds of billions of parameters possible.

**ERIC:** That's right. We're talking about ZeRO: Memory Optimizations Toward Training Trillion Parameter Models, published by Samyam Rajbhandari, Jeff Rasley, Olatunji Ruwase, and Yuxiong He from Microsoft Research.

**MAYA:** This paper came out in late 2019, and Eric, I remember exactly where I was when I first read it. I was trying to train a relatively modest transformer model, maybe 500 million parameters, and I kept running out of memory. I was so frustrated.

**ERIC:** And that frustration was universal. Everyone in the field was hitting the same wall.

**MAYA:** Exactly. When this paper dropped, it felt like someone had finally given us the keys to a door we'd been banging our heads against. Before ZeRO, if you wanted to train a really big model, you basically had two options, and neither was great.

**ERIC:** Let's set the stage for our listeners who might not remember 2019 in the AI world. GPT-2 had just come out with 1.5 billion parameters, and it was causing a huge stir. OpenAI initially didn't even release the full model because they were worried about misuse.

**MAYA:** Right, and at the time, 1.5 billion parameters seemed enormous. People were genuinely asking: is this the limit? Can we even train anything bigger? The hardware just didn't seem to support it.

**ERIC:** And here's the thing that I think surprises a lot of people even today: the model parameters themselves aren't even the main memory hog during training. There's this whole hidden iceberg of memory consumption that most people don't think about.

**MAYA:** That's the perfect setup for our first segment. Let's dig into why training large models is so memory-intensive.

---

## [SEGMENT 1: THE MEMORY PROBLEM - 3:00]

**ERIC:** Okay, so let's break this down from first principles. When you're training a neural network, what's actually living in GPU memory?

**MAYA:** So most people think it's just the weights, right? The model parameters. And sure, that's part of it. For a 1.5 billion parameter model using 16-bit floating point, that's about 3 gigabytes. Sounds manageable.

**ERIC:** But that's just the tip of the iceberg.

**MAYA:** Exactly. Let me walk through everything. First, you have the parameters in 16-bit precision for the forward and backward pass. That's your 3 gigs. But then you also need to store the gradients—the derivatives you compute during backpropagation. That's another copy of every parameter, so another 3 gigs.

**ERIC:** We're already at 6 gigabytes.

**MAYA:** And we haven't even gotten to the big one yet. If you're using the Adam optimizer, which is basically the default for training transformers, you need to store what's called the optimizer states.

**ERIC:** Can you explain what those are for listeners who might not be familiar?

**MAYA:** Sure. Adam is an adaptive learning rate optimizer. It keeps track of two running averages for every single parameter in your model. The first is the mean of the gradients—that's the first moment, or momentum. The second is the mean of the squared gradients—that's the second moment, used to scale the learning rate.

**ERIC:** So that's two additional values per parameter.

**MAYA:** Right, but here's the kicker. These optimizer states need to be stored in 32-bit precision, not 16-bit. Even if you're doing mixed precision training with 16-bit activations and gradients, the optimizer states have to be 32-bit for numerical stability.

**ERIC:** Why is that?

**MAYA:** It comes down to the accumulation of small updates. Over thousands of training steps, you're adding tiny gradient values to these running averages. In 16-bit precision, you lose too much information in those small updates. The training becomes unstable or just stops converging.

**ERIC:** So we have 4 bytes per parameter for momentum, 4 bytes for variance...

**MAYA:** And you also need a 32-bit master copy of the parameters themselves for the optimizer to update. So that's another 4 bytes per parameter. In total, the optimizer states require 12 bytes per parameter.

**ERIC:** Let me add this up. For a 1.5 billion parameter model: 3 gigs for fp16 parameters, 3 gigs for fp16 gradients, and 12 bytes times 1.5 billion is... 18 gigabytes just for optimizer states.

**MAYA:** So we're at 24 gigabytes total for what the paper calls "model states." And we haven't even talked about activations yet.

**ERIC:** Ah yes, the activations. This is what catches a lot of people off guard.

**MAYA:** During the forward pass, you compute intermediate values at every layer—the activations. And you have to keep them around because you need them for the backward pass to compute gradients.

**ERIC:** How much memory do activations use?

**MAYA:** It depends heavily on your batch size and sequence length. For transformers, activation memory scales quadratically with sequence length because of the attention mechanism. For a reasonable batch size and sequence length, you could easily need another 10, 20, even 50 gigabytes.

**ERIC:** So we're looking at potentially 50, 60, 70 gigabytes for a model that only has 3 gigabytes of actual weights.

**MAYA:** Exactly! And this is why people were hitting walls. Even the best GPUs at the time, the NVIDIA V100, only had 32 gigabytes of memory. You literally couldn't fit the training state for a moderately sized model on a single GPU.

**ERIC:** The paper has this great analysis where they categorize memory into model states versus residual states—the activations, temporary buffers, and fragmentation. And they show that for GPT-2 scale models, it's actually the model states that dominate.

**MAYA:** Which is a crucial insight because it tells you where to focus your optimization efforts.

---

## [SEGMENT 2: EXISTING SOLUTIONS AND THEIR LIMITATIONS - 7:30]

**ERIC:** So before ZeRO came along, how were people dealing with this memory problem?

**MAYA:** There were two main paradigms: data parallelism and model parallelism. Both had been around for years, but neither really solved the fundamental problem.

**ERIC:** Let's start with data parallelism since it's the more common one.

**MAYA:** Sure. Data parallelism is conceptually the simplest form of distributed training. You take your model, make complete copies of it on every GPU, and then split your training data across them.

**ERIC:** So if you have 8 GPUs and a batch size of 64...

**MAYA:** Each GPU processes 8 samples. They all do a forward pass, compute gradients, and then you average the gradients across all GPUs. Everyone updates their weights the same way, so they stay synchronized.

**ERIC:** The averaging step is the key communication operation, right?

**MAYA:** Exactly. It's called an all-reduce. Every GPU sends its gradients, they get summed up and averaged, and every GPU gets back the averaged result. Libraries like PyTorch's DistributedDataParallel and NVIDIA's NCCL make this very efficient.

**ERIC:** So what's the problem with data parallelism?

**MAYA:** The fatal flaw is that every GPU has a complete copy of everything—parameters, gradients, optimizer states. If your model needs 24 gigabytes, it needs 24 gigabytes on every single GPU.

**ERIC:** So you're not solving the memory problem at all.

**MAYA:** Not at all. You're just training faster by processing more data in parallel. If you have 64 GPUs, you're storing 64 complete copies of a 24 gigabyte model. That's over 1.5 terabytes of memory holding identical information! The paper calls this "redundant memory consumption."

**ERIC:** That's such a waste.

**MAYA:** It really is. And it means data parallelism can't help you train bigger models. It only helps you train faster on models that already fit in memory.

**ERIC:** What about model parallelism?

**MAYA:** Model parallelism takes the opposite approach. Instead of replicating the model, you partition it across GPUs. There are two main flavors: pipeline parallelism and tensor parallelism.

**ERIC:** Walk us through those.

**MAYA:** Pipeline parallelism is like an assembly line. You split the model by layers. GPU 1 has layers 1 through 10, GPU 2 has layers 11 through 20, and so on. Data flows through the pipeline—GPU 1 computes its part, sends activations to GPU 2, which computes its part, and so on.

**ERIC:** That sounds reasonable.

**MAYA:** It is, but there's a big problem called pipeline bubbles. When GPU 1 is working on the first microbatch, GPUs 2 through 8 are sitting idle. When GPU 8 is finishing up, GPUs 1 through 7 are idle. You end up with a lot of wasted compute.

**ERIC:** There are techniques to reduce the bubbles though, right?

**MAYA:** Yes, like microbatching and interleaved schedules. GPipe and PipeDream introduced clever scheduling to overlap work. But you can never fully eliminate the bubbles, and the implementation complexity is significant.

**ERIC:** And tensor parallelism?

**MAYA:** Tensor parallelism splits individual operations across GPUs. The Megatron-LM paper from NVIDIA showed how to do this for transformers. You split the big matrix multiplications in the attention and feed-forward layers across GPUs.

**ERIC:** That sounds like it would require a lot of communication.

**MAYA:** It does. After every split operation, you need to synchronize results. This means tensor parallelism really only works efficiently within a node, where you have fast NVLink connections between GPUs. Once you go across nodes, the communication overhead kills your throughput.

**ERIC:** So tensor parallelism might let you split across 8 GPUs in a node...

**MAYA:** But not across 64 GPUs spanning 8 nodes. You hit a scaling wall.

**ERIC:** And both forms of model parallelism require significant code changes, right?

**MAYA:** That's maybe the biggest practical problem. With data parallelism, you can take a standard PyTorch model and add a couple lines of code. With model parallelism, you often have to completely restructure how your model is defined and how the forward pass works. It's not plug-and-play.

**ERIC:** Which brings us to ZeRO and its key insight.

---

## [SEGMENT 3: THE ZERO INSIGHT - 12:30]

**MAYA:** Okay, so here's the fundamental question the ZeRO authors asked: In data parallelism, we have all this redundant memory. What if we could eliminate that redundancy while keeping data parallelism's simplicity and scalability?

**ERIC:** That's a really elegant reframing of the problem.

**MAYA:** Right? Instead of saying "data parallelism doesn't help with memory," they said "what if we could make data parallelism memory-efficient?" The key observation is that even though every GPU computes gradients for all parameters, each GPU only needs to update a subset of them.

**ERIC:** Explain that more.

**MAYA:** Think about it this way. In standard data parallelism, after the backward pass, every GPU has gradients for all parameters. They do an all-reduce to average them, and then every GPU independently updates all parameters using those gradients.

**ERIC:** Right, they all do the same update, which is why they stay synchronized.

**MAYA:** Exactly. But here's the thing—since they all do the exact same update, why does every GPU need to do it? What if GPU 0 only updated parameters 0 through 1000, GPU 1 updated parameters 1001 through 2000, and so on?

**ERIC:** And then you'd need to share the updated parameters...

**MAYA:** But you could do that! After each GPU updates its portion, you do an all-gather so everyone gets the full set of updated parameters. The total amount of communication is actually the same as an all-reduce.

**ERIC:** Wait, really? The same communication cost?

**MAYA:** Yes! An all-reduce is mathematically equivalent to a reduce-scatter followed by an all-gather. In standard data parallelism, you're doing an all-reduce on gradients. In ZeRO, you're doing a reduce-scatter on gradients, then each GPU updates its portion, then an all-gather on parameters. Same total bytes moved.

**ERIC:** But now each GPU only stores a fraction of the optimizer states.

**MAYA:** Exactly! That's ZeRO Stage 1—partition the optimizer states. If you have 64 GPUs, each one stores 1/64th of the optimizer states. For our earlier example, that takes you from 18 gigabytes of optimizer states per GPU down to less than 300 megabytes.

**ERIC:** That's a huge savings.

**MAYA:** The name ZeRO stands for Zero Redundancy Optimizer, and the name really captures what's happening. You're eliminating the redundant storage of optimizer states across GPUs.

**ERIC:** But they didn't stop at optimizer states.

**MAYA:** No, they went further. ZeRO Stage 2 partitions the gradients as well. During backpropagation, instead of every GPU accumulating all gradients, you use a reduce-scatter operation. Each GPU only keeps the gradients for its partition of parameters.

**ERIC:** So you're saving another chunk of memory.

**MAYA:** Right. The gradients were 3 gigabytes in our example. With Stage 2 on 64 GPUs, each GPU only stores about 50 megabytes of gradients.

**ERIC:** And then there's Stage 3.

**MAYA:** Stage 3 is the full monty. It partitions the parameters themselves. Each GPU only stores 1/Nth of the model parameters at rest.

**ERIC:** But wait—you need all the parameters to actually compute the forward and backward passes.

**MAYA:** You do, and this is where it gets clever. Just before you need to use a layer's parameters, you do an all-gather to collect them from all GPUs. You compute the forward or backward pass for that layer, and then you can discard the parameters you're not responsible for.

**ERIC:** So you're constantly gathering and discarding?

**MAYA:** Layer by layer, yes. This means more communication—the paper says about 1.5x the communication of baseline data parallelism. But in return, each GPU now stores only 1/Nth of everything: parameters, gradients, and optimizer states.

**ERIC:** With 1000 GPUs...

**MAYA:** Each GPU stores 1/1000th of the model states. A model that would need 24 gigabytes on a single GPU now needs 24 megabytes per GPU. You can train models with trillions of parameters—something that was completely impossible before.

---

## [SEGMENT 4: COMMUNICATION PRIMITIVES DEEP DIVE - 17:00]

**ERIC:** I think it would help our listeners to really understand the communication operations here. Can you explain all-reduce, reduce-scatter, and all-gather?

**MAYA:** Absolutely. These are the bread and butter of distributed computing, so let's break them down.

**ERIC:** Start with all-reduce.

**MAYA:** Okay, imagine you have 4 GPUs, each with a value. GPU 0 has 1, GPU 1 has 2, GPU 2 has 3, GPU 3 has 4. An all-reduce sums them up and gives every GPU the result. After all-reduce, every GPU has the value 10.

**ERIC:** So everyone contributes, everyone gets the result.

**MAYA:** Exactly. Now, reduce-scatter is different. You still sum up the values, but instead of everyone getting the complete result, the result is scattered across GPUs. If we're summing and scattering across 4 pieces, GPU 0 gets the first quarter of the sum, GPU 1 gets the second quarter, and so on.

**ERIC:** So the result is distributed.

**MAYA:** Right. And all-gather is the opposite of scatter. Each GPU has a piece of data, and after all-gather, every GPU has all the pieces concatenated together.

**ERIC:** So reduce-scatter followed by all-gather equals all-reduce.

**MAYA:** Exactly! That's the key mathematical identity that makes ZeRO work. You're just reorganizing the communication pattern. Instead of everyone having everything all the time, you distribute storage but gather on-demand when you need it.

**ERIC:** And modern communication libraries are really good at implementing these efficiently.

**MAYA:** They are. NCCL, which stands for NVIDIA Collective Communications Library, has highly optimized implementations that use ring-based algorithms, tree reductions, and other techniques to minimize latency and maximize bandwidth utilization.

**ERIC:** The paper mentions overlapping communication with computation. How does that work?

**MAYA:** This is a crucial optimization. Remember that in ZeRO-3, you need to gather parameters before computing each layer. The naive approach would be: gather layer 1 parameters, compute layer 1, gather layer 2 parameters, compute layer 2, and so on.

**ERIC:** Serializing everything.

**MAYA:** Right, which would be slow. But in practice, while GPU compute is happening for layer 1, the communication hardware can already be fetching layer 2's parameters. Modern GPUs have separate engines for compute and communication that can run concurrently.

**ERIC:** So you're pipelining the gathering with the computation.

**MAYA:** Exactly. If you structure things right, the communication is almost entirely hidden behind computation. The paper shows that with proper overlap, ZeRO-3's extra communication has minimal impact on end-to-end training time.

---

## [SEGMENT 5: THE MATH AND MEMORY ANALYSIS - 20:00]

**ERIC:** Let's get into the quantitative analysis. The paper has some nice formulas for memory consumption.

**MAYA:** They do. Let me set up the notation. They use the Greek letter psi, Ψ, to represent the number of model parameters. For mixed precision training with Adam, the memory consumption per GPU in standard data parallelism is:

2Ψ bytes for parameters in fp16, plus 2Ψ bytes for gradients in fp16, plus 4Ψ for the fp32 master copy, plus 4Ψ for momentum, plus 4Ψ for variance.

**ERIC:** So that's 16Ψ total bytes.

**MAYA:** Right, 16 bytes per parameter. For a 7.5 billion parameter model, that's 120 gigabytes just for model states on every GPU.

**ERIC:** And with ZeRO?

**MAYA:** With ZeRO Stage 1, you partition the optimizer states. The 12Ψ bytes for fp32 master copy, momentum, and variance get divided by N, the number of GPUs. So your memory becomes 4Ψ plus 12Ψ/N.

**ERIC:** And with Stage 2?

**MAYA:** The gradients also get partitioned. Now you have 2Ψ for parameters plus 2Ψ/N for gradients plus 12Ψ/N for optimizer states. That simplifies to 2Ψ plus 14Ψ/N.

**ERIC:** And Stage 3?

**MAYA:** Everything is partitioned. It's simply 16Ψ/N. With 64 GPUs, each GPU stores only 1/64th of those 120 gigabytes. That's less than 2 gigabytes per GPU.

**ERIC:** Which means you have tons of memory left for activations.

**MAYA:** Exactly. And the paper makes another key observation. As you increase N, the number of GPUs, you can proportionally increase Ψ, the model size, while keeping per-GPU memory constant.

**ERIC:** Linear scaling.

**MAYA:** Right. Double your GPUs, double your model size. This is fundamentally different from model parallelism where the scaling relationship is more complex.

**ERIC:** There's also analysis of when each stage is most beneficial, right?

**MAYA:** Yes. ZeRO-1 gives you about 4x memory reduction with no extra communication. ZeRO-2 gives you about 8x with still the same communication as baseline. ZeRO-3 gives you linear reduction with N, but at 1.5x communication.

**ERIC:** So there's a tradeoff.

**MAYA:** Right. For moderately sized models, ZeRO-1 or ZeRO-2 might be enough. For truly massive models, you need ZeRO-3 and accept the communication overhead.

---

## [SEGMENT 6: IMPLEMENTATION AND DEEPSPEED - 23:00]

**ERIC:** Let's talk about the practical implementation. The paper introduces ZeRO as part of Microsoft's DeepSpeed library.

**MAYA:** Yes, DeepSpeed is their open-source deep learning optimization library. It's built on top of PyTorch and provides a whole suite of optimizations, but ZeRO is the crown jewel.

**ERIC:** What does it look like to use in practice?

**MAYA:** It's remarkably simple. You have your normal PyTorch model. Instead of wrapping it with DistributedDataParallel, you use DeepSpeed's initialization function. You pass in a config file that specifies which ZeRO stage you want, and the library handles everything else.

**ERIC:** Show me a rough example.

**MAYA:** Okay, so you'd have something like: model, optimizer, equals deepspeed.initialize, passing in your model, your config, and so on. The config file might have a section that says zero optimization, stage 3. That's literally it.

**ERIC:** No changes to the model code?

**MAYA:** Almost none. With ZeRO-1 and ZeRO-2, typically zero changes. With ZeRO-3, there's one gotcha: since parameters aren't all present on each GPU, if you want to access parameters outside the forward/backward pass—like for logging or debugging—you need to use a context manager.

**ERIC:** What does that look like?

**MAYA:** Something like: with deepspeed.zero.GatheredParameters, then you can access model.parameters. The context manager temporarily gathers the full parameters so you can inspect them.

**ERIC:** The paper also mentions several optimizations. Gradient bucketing, communication overlap...

**MAYA:** Yes. Gradient bucketing is borrowed from standard distributed training. Instead of communicating many small tensors, you batch them into larger buckets. This amortizes the fixed overhead of communication calls.

**ERIC:** And there's also CPU offloading mentioned.

**MAYA:** That became ZeRO-Offload in a follow-up paper. The idea is that CPU memory is much larger than GPU memory, so you can offload some of the optimizer states to CPU RAM. The tradeoff is PCIe bandwidth, but for large enough models, it's worth it.

---

## [SEGMENT 7: EXPERIMENTAL RESULTS - 25:30]

**ERIC:** Let's talk results. What did the experiments show?

**MAYA:** The headline result was training Turing-NLG, a 17 billion parameter model, and showing that they could scale to 100 billion parameters. At the time, this was unprecedented.

**ERIC:** How does the performance compare to baselines?

**MAYA:** ZeRO-1 gives 4x memory reduction with literally zero performance overhead. Same throughput as standard data parallelism.

**ERIC:** Because the communication pattern is equivalent.

**MAYA:** Right. ZeRO-2 actually showed slight throughput improvement in some cases, which surprised people.

**ERIC:** How is that possible?

**MAYA:** Reduced memory pressure means better cache behavior. When you're not pushing GPU memory to its limits, memory access patterns become more efficient.

**ERIC:** And ZeRO-3?

**MAYA:** ZeRO-3 has about 10-15% throughput reduction due to the extra communication. But the key point is it enables model sizes that are completely impossible otherwise. You're trading a bit of speed for capability you literally didn't have before.

**ERIC:** They also compared against model parallelism, right?

**MAYA:** Yes, and this was eye-opening. For the same model size, ZeRO-3 matched or exceeded the throughput of pipeline and tensor parallelism, while being much simpler to implement.

**ERIC:** And the combination works too.

**MAYA:** That's the key insight for training the largest models today. You use tensor parallelism within a node to efficiently utilize NVLink, and ZeRO across nodes for memory efficiency. Models like GPT-3, Megatron-Turing, and most large language models use this hybrid approach.

---

## [SEGMENT 8: IMPACT, LEGACY, AND FOLLOW-UP WORK - 28:00]

**ERIC:** We're several years out from this paper now. What's the impact been?

**MAYA:** Massive. ZeRO is everywhere. DeepSpeed is one of the most widely used training libraries for large models. Hugging Face integrated ZeRO directly into their Trainer API. Pretty much every open-source effort to train large language models—LLaMA, Falcon, you name it—uses ZeRO or ZeRO-inspired techniques.

**ERIC:** And there's been a lot of follow-up work.

**MAYA:** So much. ZeRO-Offload extended the idea to CPU memory. ZeRO-Infinity pushed it further to NVMe storage—you can train trillion-parameter models on a single machine with enough SSDs. ZeRO++ optimized communication patterns for specific network topologies.

**ERIC:** What about PyTorch's FSDP?

**MAYA:** Fully Sharded Data Parallel is essentially ZeRO-3 built natively into PyTorch. The PyTorch team collaborated with the DeepSpeed team, and now you can do ZeRO-style training without even using DeepSpeed if you prefer.

**ERIC:** Has the idea influenced other frameworks?

**MAYA:** Definitely. JAX has similar functionality. Google's work on GSPMD incorporates sharding ideas. The whole field moved toward the insight that data parallelism can be memory-efficient if you partition cleverly.

**ERIC:** What made this paper so influential, in your view?

**MAYA:** Three things. First, timing. The scaling laws were just being discovered, everyone wanted bigger models, and ZeRO removed the memory barrier. Second, execution. The DeepSpeed library was well-engineered and easy to use. Third, communication. The paper itself is exceptionally clear—it explains the problem, the insight, and the solution in a way that's accessible but rigorous.

**ERIC:** Any limitations we should mention?

**MAYA:** The main one is that ZeRO addresses model state memory but not activation memory. For very long sequences, activations can still be the bottleneck. You need techniques like activation checkpointing, where you recompute activations during the backward pass instead of storing them.

**ERIC:** And network bandwidth matters.

**MAYA:** Yes, ZeRO-3 assumes reasonably fast interconnect. On clusters with slow networking, the communication overhead can hurt more than the analysis suggests.

---

## [OUTRO - 30:30]

**ERIC:** Well, we've covered a lot of ground. Any final thoughts?

**MAYA:** Just that this paper is a great example of how a simple, elegant idea can have enormous impact. The insight—eliminate redundancy in data parallelism through partitioning—seems obvious in retrospect. But it took real engineering and theoretical clarity to make it work.

**ERIC:** It's also a reminder that systems papers matter. You can have the best algorithms in the world, but if you can't run them at scale, they stay theoretical. ZeRO made the theory practical.

**MAYA:** If you're working in ML and haven't read this paper, go read it. It's one of those rare papers that's both foundational and practical. The ideas are elegant, the engineering is solid, and the impact is undeniable.

**ERIC:** That's going to do it for today's episode of Strollcast. Thanks for listening, everyone.

**MAYA:** If you enjoyed this deep dive, check out our other episodes at strollcast.com. Let us know what papers you want us to cover next.

**ERIC:** Until next time, keep strolling.

**MAYA:** And may your gradients never explode.

**[Outro music fades in]**

**ERIC:** That's still a terrible sign-off.

**MAYA:** And I'm still keeping it.

**[Music plays for 10 seconds, fades out]**

---

## REFERENCES

- Rajbhandari, S., Rasley, J., Ruwase, O., & He, Y. (2020). ZeRO: Memory Optimizations Toward Training Trillion Parameter Models. *SC20: International Conference for High Performance Computing, Networking, Storage and Analysis*.

- Paper available at: https://arxiv.org/abs/1910.02054

- DeepSpeed library: https://github.com/microsoft/DeepSpeed

---

*Total runtime: Approximately 30-32 minutes at conversational pace*
*Word count: ~7,500 words*
