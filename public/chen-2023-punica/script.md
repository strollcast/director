# Punica: Multi-Tenant LoRA Serving

## [Introduction]

**ERIC:** Welcome to Strollcast! I'm Eric.

**MAYA:** And I'm Maya. We're your AI hosts, here to make research accessible while you're on the move.

**ERIC:** Today we're diving into Punica, a system for serving multiple LoRA models efficiently. It's from Lequn Chen, Zihao Ye, and colleagues at the University of Washington and Duke.

**MAYA:** This paper tackles a problem that's becoming increasingly common: you have one base LLM, but many different fine-tuned versions for different users or tasks.

**ERIC:** Think of a platform where each customer has their own specialized LoRA adapter. Maybe one for legal documents, one for medical notes, one for code review.

**MAYA:** The naive approach is to load each LoRA model separately. But that's wasteful because they all share the same base model weights.

**ERIC:** Punica's insight is that you can batch requests across different LoRA models and process them together. The result is 12x higher throughput compared to existing serving systems.

**MAYA:** Let's break down how they achieved this.

## [The Multi-Tenant Problem]

**ERIC:** First, let's understand the problem. LoRA, or Low-Rank Adaptation, adds small trainable matrices to a frozen base model.

**MAYA:** Each LoRA adapter might only be a few megabytes. But the base model could be tens of gigabytes.

**ERIC:** If you serve LoRA models the traditional way, you load the base model plus one adapter, process requests, then swap to another adapter for different requests.

**MAYA:** That's inefficient for two reasons. First, you're not batching across users with different adapters. Second, swapping adapters has overhead.

**ERIC:** The ideal would be: load the base model once, keep multiple adapters in memory, and process requests for all of them simultaneously.

**MAYA:** But here's the challenge. During inference, LoRA adds a computation: the input gets multiplied by adapter matrices A and B.

**ERIC:** If different requests in your batch use different adapters, you can't just do one big matrix multiplication. Each request needs its own adapter weights.

**MAYA:** This is where Punica's key innovation comes in: the SGMV kernel.

## [SGMV: The Core Innovation]

**ERIC:** SGMV stands for Segmented Gather Matrix-Vector multiplication. It's a custom CUDA kernel designed specifically for this multi-LoRA scenario.

**MAYA:** Let's unpack what that means. Normally, when you batch requests in an LLM, you combine all the inputs and do one big matrix multiplication.

**ERIC:** With multiple LoRA adapters, you have a problem. Request 1 needs adapter A, request 2 needs adapter B, request 3 needs adapter A again, and so on.

**MAYA:** SGMV handles this by segmenting the batch. It groups requests by their LoRA adapter, then processes each segment with the appropriate weights.

**ERIC:** But here's the clever part: it does this within a single kernel launch. No separate kernel calls for each adapter.

**MAYA:** The kernel gathers the right adapter weights for each segment, performs the matrix-vector multiplications in parallel, then scatters the results back.

**ERIC:** This maintains high GPU utilization because you're still processing a large batch. You just route different parts of the batch through different adapters.

## [How SGMV Works]

**MAYA:** Let's get a bit more technical on the SGMV implementation.

**ERIC:** The kernel has two variants: expand and shrink. In LoRA, you have two matrices per adapter. Matrix A expands the hidden dimension to the low-rank dimension, and matrix B shrinks it back.

**MAYA:** For the expand kernel, they parallelize across the output feature dimension. Each CUDA block handles a specific LoRA adapter.

**ERIC:** The shrink kernel is trickier because the output dimension is small, often just 8 or 16. Not enough parallelism there.

**MAYA:** So they use a split-K strategy. They divide the input dimension across multiple blocks and do a reduction at the end.

**ERIC:** Both kernels leverage GPU tensor cores for the actual matrix multiplication. That's critical for performance.

**MAYA:** The result is that batching different LoRA models has nearly the same throughput as batching identical models.

**ERIC:** In their experiments, they saw negligible performance difference between the "identical" case where all requests use the same adapter and the "distinct" case where every request uses a different adapter.

**MAYA:** That's remarkable. It means you get efficient multi-tenant serving essentially for free.

## [System Architecture]

**ERIC:** SGMV is the core kernel, but Punica is a complete serving system. Let's talk about the architecture.

**MAYA:** There are three main components: the scheduler, the SGMV execution layer, and memory management.

**ERIC:** The scheduler receives incoming requests, each tagged with which LoRA adapter it needs. It groups requests into batches for processing.

**MAYA:** The key scheduling decision is how to compose batches. You want to maximize GPU utilization while keeping latency reasonable.

**ERIC:** Punica batches requests across different LoRA models within a single iteration. This is what enables the high throughput.

**MAYA:** For memory management, Punica caches adapter weights on the GPU. Popular adapters stay resident.

**ERIC:** Less popular adapters can be loaded on demand. The loading latency is only milliseconds because adapters are small.

**MAYA:** This gives Punica flexibility. You're not constrained by which adapters are currently loaded on a GPU.

**ERIC:** The system can consolidate requests to a small set of GPUs, loading adapters as needed, rather than pinning specific adapters to specific GPUs.

## [Performance Results]

**MAYA:** Let's talk numbers. How much does Punica actually improve over existing systems?

**ERIC:** They compared against vLLM, which was the state-of-the-art LLM serving system at the time.

**MAYA:** In the multi-LoRA scenario, Punica achieved 12x higher throughput while adding only 2 milliseconds of latency per token.

**ERIC:** That 2 milliseconds is the overhead from the SGMV kernel compared to standard matrix multiplication. It's negligible for most applications.

**MAYA:** They tested various workload distributions. "Distinct" where every request uses a different adapter. "Identical" where all requests use the same one.

**ERIC:** Also "Uniform" where adapters are equally popular, and "Skewed" where popularity follows a Zipf distribution, meaning a few adapters get most of the traffic.

**MAYA:** Across all distributions, Punica maintained high throughput. The skewed case was actually easiest because popular adapters stay hot in cache.

**ERIC:** They also tested with different numbers of concurrent LoRA models. Punica scaled well up to hundreds of different adapters.

**MAYA:** Memory efficiency was another win. By sharing the base model and only storing small adapters, GPU memory goes much further.

## [Why This Matters]

**ERIC:** Let's zoom out and discuss the implications. Why is multi-tenant LoRA serving important?

**MAYA:** The rise of LoRA has changed how organizations customize LLMs. Instead of fine-tuning the whole model, you train small adapters.

**ERIC:** A single base model can have hundreds or thousands of LoRA adapters for different tasks, domains, or customers.

**MAYA:** Think of it like a platform. The platform provider hosts the base LLM. Each customer uploads their specialized adapter.

**ERIC:** Without Punica, serving this efficiently was hard. You'd either dedicate GPUs per customer, which is wasteful, or swap adapters constantly, which is slow.

**MAYA:** Punica enables true multi-tenancy. One GPU cluster serves all customers efficiently, dynamically loading adapters as needed.

**ERIC:** This reduces the cost per customer dramatically. It makes personalized LLMs economically viable.

**MAYA:** And it's not just about cost. Lower latency means better user experience. Higher throughput means serving more users.

## [Connection to Other Work]

**ERIC:** Punica fits into a broader ecosystem of LLM serving optimizations. Let's connect it to related work.

**MAYA:** vLLM introduced PagedAttention for efficient KV cache management. Punica is complementary; it optimizes the LoRA computation, not the attention.

**ERIC:** You could combine Punica's SGMV with vLLM's memory management. In fact, vLLM has since incorporated similar multi-LoRA support.

**MAYA:** There's also work on LoRA weight compression. If adapters are smaller, you can cache more of them.

**ERIC:** And techniques like LoRA merging, where you combine multiple adapters into one, can reduce the number of distinct adapters at the cost of some specificity.

**MAYA:** Punica's approach is orthogonal to these. It doesn't require changing the adapters themselves, just how you batch the computation.

**ERIC:** The SGMV kernel is open source. Other serving systems have adopted similar techniques since the paper came out.

## [Practical Considerations]

**MAYA:** For listeners thinking about deploying this, let's cover some practical points.

**ERIC:** First, Punica is most beneficial when you have many different LoRA adapters. If you only have one or two, the overhead isn't worth it.

**MAYA:** The crossover point depends on your workload, but roughly: if you're frequently switching between more than a handful of adapters, Punica helps.

**ERIC:** Adapter size matters for memory planning. Typical LoRA adapters for a 7B model might be 10 to 50 megabytes.

**MAYA:** For a 70B model, adapters could be a few hundred megabytes. Still small compared to the base model, but they add up.

**ERIC:** Loading latency is proportional to adapter size divided by PCIe bandwidth. With NVLink or on-GPU cache, it's faster.

**MAYA:** The scheduler's batching strategy can be tuned. Larger batches improve throughput but increase latency.

**ERIC:** In practice, you want to set latency SLOs and let the scheduler maximize throughput within those bounds.

## [Limitations]

**MAYA:** Every system has limitations. What are Punica's?

**ERIC:** First, SGMV has some overhead compared to fused operations for single-LoRA serving. If you only ever use one adapter, don't use Punica.

**MAYA:** Second, the current implementation focuses on LoRA specifically. Other adapter types like adapters from AdapterHub or prefix tuning would need different kernels.

**ERIC:** Third, very large batches with many distinct adapters can reduce arithmetic intensity. The segments become too small.

**MAYA:** In practice, they found this wasn't a problem for realistic workloads. But it's a theoretical limitation.

**ERIC:** Finally, Punica assumes adapters are available when requests arrive. If you need to train new adapters on demand, that's a different problem.

## [Conclusion]

**MAYA:** Let's summarize what we've learned about Punica.

**ERIC:** The core insight is that multi-tenant LoRA serving can be efficient if you batch across adapters intelligently.

**MAYA:** The SGMV kernel enables this by segmenting batches and processing each segment with the appropriate adapter weights.

**ERIC:** The kernel uses GPU tensor cores, split-K parallelization, and careful memory access patterns to maintain high throughput.

**MAYA:** The full Punica system adds scheduling, memory management, and on-demand adapter loading.

**ERIC:** The result is 12x higher throughput than naive approaches, with only 2 milliseconds additional latency.

**MAYA:** This makes personalized LLMs economically viable. One GPU cluster can serve hundreds of specialized adapters.

**ERIC:** The code is open source at punica-ai/punica on GitHub. Similar techniques have been adopted by vLLM and other serving systems.

**MAYA:** If you're building a platform with many fine-tuned models, multi-tenant serving is something to think about.

**ERIC:** The paper is on arXiv at 2310.18547, and was published at MLSys 2024.

## [Quiz 1]

**ERIC:** Time to test your understanding with a couple of quizzes.

**MAYA:** Quiz: What is the main challenge that prevents naive batching when serving multiple different LoRA adapters, and how does SGMV solve it?

**ERIC:** Take a moment to think about it.

**MAYA:** Answer: The main challenge is that different requests in a batch need different adapter weights. You can't do one big matrix multiplication because each request's LoRA computation requires its own A and B matrices. SGMV solves this by segmenting the batch, grouping requests by their adapter, and processing all segments in a single kernel launch. It gathers the appropriate weights for each segment, performs parallel matrix-vector multiplications, and scatters results back.

## [Quiz 2]

**ERIC:** Here's quiz number two.

**MAYA:** Quiz: Why does Punica use a split-K strategy for the shrink kernel but not for the expand kernel?

**ERIC:** Think back to what we covered about the kernel implementation.

**MAYA:** Answer: The shrink kernel reduces from the hidden dimension to the low-rank dimension, which is typically small, like 8 or 16. There's not enough parallelism in such a small output dimension to keep the GPU busy. Split-K divides the work along the input dimension instead, giving each block a portion to process, then combines results with a reduction. The expand kernel doesn't need this because it outputs to the full hidden dimension, which provides plenty of parallelism naturally.

## [Sign Off]

**ERIC:** That's all for today's episode on Punica.

**MAYA:** Thanks for joining us on this exploration of efficient multi-LoRA serving.

**ERIC:** Until next time, keep strolling.

**MAYA:** And may your gradients never explode.
