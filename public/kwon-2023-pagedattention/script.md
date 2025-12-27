# Efficient Memory Management for Large Language Model Serving with PagedAttention

## Introduction

**ERIC:** Welcome to Strollcast! I'm Eric.

**MAYA:** And I'm Maya. We're your AI hosts, here to make research accessible while you're on the move.

**ERIC:** Today we're diving into a paper that tackles one of the biggest bottlenecks in serving large language models - memory management. It's called "Efficient Memory Management for Large Language Model Serving with PagedAttention" and it introduces vLLM, which has become a hugely popular serving system.

**MAYA:** This paper is particularly exciting because it takes a classic computer science concept - virtual memory from operating systems - and cleverly applies it to solve modern AI infrastructure problems. The authors are from UC Berkeley, Stanford, and UC San Diego, led by Woosuk Kwon and Zhuohan Li.

**ERIC:** What's really cool is how they achieve 2 to 4 times better throughput compared to existing systems like FasterTransformer and Orca, without changing the model accuracy at all. {{page: 1, section: "Abstract", excerpt: "Our evaluations show that vLLM improves the throughput of popular LLMs by 2-4× with the same level of latency"}}

**MAYA:** Before we dive into the technical details, let's set the stage. Why is serving large language models so challenging from a memory perspective?

## Background and The Memory Problem

**ERIC:** Think about how ChatGPT or any language model works. It doesn't just spit out entire responses instantly - it generates one word at a time, and each new word depends on all the previous words it's seen. 

**MAYA:** Exactly. This sequential generation process creates what's called a key-value cache, or KV cache for short. For every token the model processes, it needs to store some internal state - the keys and values from the attention mechanism - to efficiently generate the next token. {{page: 7, section: "2.2", excerpt: "the key and value vectors of existing tokens are often cached for generating future tokens, known as KV cache"}}

**ERIC:** Here's where it gets crazy. For a 13 billion parameter model like OPT-13B, each single token requires 800 kilobytes of KV cache storage. That's calculated as 2 times 5120 times 40 times 2 - accounting for both keys and values, the hidden state size, number of layers, and bytes per floating point number. {{page: 12, section: "3", excerpt: "the KV cache of a single token demands 800 KB of space, calculated as 2 (key and value vectors) × 5120 (hidden state size) × 40 (number of layers) × 2 (bytes per FP16)"}}

**MAYA:** So if you have a sequence that's 2048 tokens long - which is pretty common - you're looking at 1.6 gigabytes just for the KV cache of one request. And remember, serving systems want to batch multiple requests together to improve GPU utilization.

**ERIC:** The math gets scary fast. Even with a high-end GPU with 40GB of memory, you can only fit a handful of requests if you're being inefficient with memory. And that's exactly what existing systems were doing.

**MAYA:** The paper shows that traditional systems were wasting 60 to 80 percent of their KV cache memory! {{page: 2, section: "1", excerpt: "only 20.4% - 38.2% of the KV cache memory is used to store the actual token states in the existing systems"}} That's like having a parking lot where 4 out of every 5 spaces are unusable due to poor layout.

## How Traditional Systems Waste Memory

**ERIC:** So what exactly were these traditional systems doing wrong? It comes down to how deep learning frameworks handle memory. Most frameworks require tensors to be stored in contiguous blocks of memory - imagine having to reserve an entire row of parking spaces even if you're not sure you'll need them all.

**MAYA:** The existing systems would pre-allocate a chunk of memory based on the maximum possible sequence length. So even if your actual request was only 100 tokens long, the system might reserve space for 2048 tokens just to be safe. {{page: 12, section: "3.1", excerpt: "they statically allocate a chunk of memory for a request based on the request's maximum possible sequence length, irrespective of the actual input or eventual output length"}}

**ERIC:** This creates three types of waste. First, there's "reserved" memory - space set aside for tokens that haven't been generated yet. Then there's "internal fragmentation" - if you reserve space for 2048 tokens but only use 500, those extra 1548 slots are wasted. Finally, there's "external fragmentation" from the memory allocator itself. {{page: 13, section: "3.1", excerpt: "reserved slots for future tokens, internal fragmentation due to over-provisioning for potential maximum sequence lengths, and external fragmentation from the memory allocator"}}

**MAYA:** The authors measured this waste across different systems and found it was astronomical. In some cases, less than 21% of allocated memory was actually being used for storing token states. It's like buying a huge house but only being able to live in one room because the rest is blocked off.

## The PagedAttention Solution

**ERIC:** So how do you solve this? The authors looked to a tried-and-true solution from operating systems: virtual memory and paging. It's a beautiful example of how old ideas can solve new problems.

**MAYA:** In operating systems, virtual memory lets programs think they have access to one big, contiguous block of memory, even though the actual physical memory might be scattered all over the place. The OS handles the mapping between what the program sees and where data actually lives. {{page: 14, section: "4.2", excerpt: "OS partitions memory into fixed-sized pages and maps user programs' logical pages to physical pages"}}

**ERIC:** PagedAttention applies this same concept to the KV cache. Instead of storing all the keys and values for a sequence in one big contiguous block, they break it up into smaller "KV blocks" - each one storing the cache for a fixed number of tokens, typically 16. {{page: 15, section: "4.1", excerpt: "PagedAttention partitions the KV cache of each sequence into KV blocks. Each block contains the key and value vectors for a fixed number of tokens"}}

**MAYA:** Think of it like this: instead of needing to reserve an entire row of parking spaces, you can use individual spaces scattered throughout the parking lot. As long as you have a map telling you where each car is parked, you can find them all when you need them.

**ERIC:** The technical magic happens in the attention computation. Traditional attention looks at all the keys and values at once. PagedAttention processes them block by block, but the mathematical result is identical. {{page: 15, section: "4.1", excerpt: "The attention computation in Eq. 4 can be transformed into the following block-wise computation"}}

**MAYA:** What I love about this approach is how it elegantly handles the dynamic nature of language generation. When you're generating a sequence, you don't know how long it will be upfront. With PagedAttention, you just allocate new blocks as you need them, rather than reserving space for the worst-case scenario.

## Memory Management in vLLM

**ERIC:** The authors built an entire serving system called vLLM around PagedAttention. The memory management works just like virtual memory in an operating system, with logical blocks that map to physical blocks.

**MAYA:** Each request gets a "block table" that maps its logical blocks to physical memory locations. When a new token is generated and you need more space, the system allocates a new physical block and updates the table. {{page: 16, section: "4.2", excerpt: "The KV block manager also maintains block tables—the mapping between logical and physical KV blocks of each request"}}

**ERIC:** Here's a concrete example. Let's say you have a prompt with 7 tokens. With a block size of 4 tokens per block, you'd need 2 logical blocks. The system might map logical block 0 to physical block 7, and logical block 1 to physical block 1. The blocks don't have to be next to each other in physical memory! {{page: 17, section: "4.3", excerpt: "vLLM maps the first 2 logical KV blocks (0 and 1) to 2 physical KV blocks (7 and 1, respectively)"}}

**MAYA:** As you generate more tokens, you fill up the existing blocks first. Only when a block is completely full do you allocate a new one. This means the waste is limited to at most one partially filled block per sequence - a huge improvement over reserving thousands of unused token slots.

## Advanced Decoding Scenarios

**ERIC:** Now here's where things get really clever. Many LLM applications don't just generate one response per request. Sometimes you want multiple samples, or you're using beam search to find the best possible output.

**MAYA:** Traditional systems handle this terribly because they duplicate all the memory. If you want 4 different completions for the same prompt, they'd store the prompt's KV cache 4 separate times, even though it's identical across all completions. {{page: 18, section: "4.4", excerpt: "one request includes multiple samples sharing the same input prompt, allowing the KV cache of the prompt to be shared as well"}}

**ERIC:** vLLM implements something called copy-on-write, borrowed from operating systems. Multiple sequences can share the same physical blocks until one of them needs to modify a block. Only then does the system make a copy. It's like having roommates share a pizza until someone wants to add their own toppings to a slice.

**MAYA:** In parallel sampling, this means you only store one copy of the prompt's KV cache, regardless of how many different completions you're generating. For beam search, the savings are even more dramatic because different search paths can share large portions of their generated content. {{page: 20, section: "4.4", excerpt: "Previous LLM serving systems require frequent memory copies of the KV cache across the beam candidates"}}

**ERIC:** The paper shows memory savings of 6 to 30% for parallel sampling and 37 to 66% for beam search, depending on the dataset and configuration. {{page: 25, section: "6.3", excerpt: "6.1% - 9.8% memory saving on parallel sampling and 37.6% - 55.2% on beam search"}}

## Handling Memory Pressure

**MAYA:** Of course, even with all these optimizations, you can still run out of GPU memory if you have enough requests. Traditional systems would just crash or reject new requests. vLLM is more sophisticated.

**ERIC:** They implement preemption with two recovery strategies. The first is swapping - moving some requests' KV cache from GPU memory to CPU memory temporarily. Think of it like moving some files to external storage when your laptop's hard drive gets full. {{page: 21, section: "4.5", excerpt: "we copy evicted blocks to the CPU memory"}}

**MAYA:** The second strategy is recomputation. Since language models are deterministic, you can always regenerate the KV cache by re-running the model on the same input. This might sound expensive, but it's often faster than swapping because modern GPUs are really fast at computation. {{page: 21, section: "4.5", excerpt: "we simply recompute the KV cache when the preempted sequences are rescheduled"}}

**ERIC:** The cool thing is that recomputation isn't as slow as you might think. If you've already generated some tokens, you can concatenate them with the original prompt and process everything in one efficient batch, rather than generating one token at a time.

## Implementation and Performance Results

**MAYA:** The implementation is surprisingly compact - just 8,500 lines of Python and 2,000 lines of C++/CUDA code. The authors had to write custom GPU kernels to handle the non-contiguous memory access patterns efficiently. {{page: 24, section: "5", excerpt: "The vLLM engine is written in 8.5K lines of Python and 2K lines of C++/CUDA code"}}

**ERIC:** They tested on models ranging from 13 billion to 175 billion parameters using real workloads from ShareGPT and Alpaca datasets. ShareGPT contains actual ChatGPT conversations, so it has longer, more varied inputs and outputs. Alpaca is more structured instruction-following data. {{page: 24, section: "6.1", excerpt: "ShareGPT dataset has 8.4× longer input prompts and 5.8× longer outputs on average than the Alpaca dataset"}}

**MAYA:** The performance improvements are substantial. Compared to FasterTransformer, vLLM achieved up to 22 times higher throughput. Compared to the more sophisticated Orca system, it was still 2-4 times better. {{page: 25, section: "6.2", excerpt: "vLLM can sustain 1.7× – 2.7× higher request rates compared to Orca (Oracle) and 2.7× – 8× compared to Orca (Max)"}}

**ERIC:** What's particularly impressive is that these improvements come purely from better memory management. The model accuracy is identical - they're running the exact same computations, just organizing memory more efficiently.

## Real-World Impact and Adoption

**MAYA:** This isn't just an academic exercise. vLLM has become one of the most popular open-source LLM serving systems. The code is available on GitHub and is actively used by companies and researchers worldwide.

**ERIC:** The techniques have broader applicability too. The paper shows how classical computer science concepts like virtual memory can be adapted to solve modern AI infrastructure challenges. It's a great example of how sometimes the best innovations come from creatively applying old ideas to new problems.

**MAYA:** One limitation they acknowledge is that these techniques work best for memory-bound workloads. If your serving system is limited by computation rather than memory, the overhead of memory indirection might not be worth it. But for LLM serving, memory is definitely the bottleneck. {{page: 31, section: "8", excerpt: "However, this does not generally hold for every GPU workload"}}

## Quiz Time

**ERIC:** Alright, let's test your understanding with a couple of questions from the paper.

**MAYA:** First question: In the PagedAttention algorithm, what is the default block size that vLLM uses, and why did the authors choose this value? Take a moment to think about the tradeoffs involved.

**ERIC:** The answer is 16 tokens per block. {{page: 28, section: "7.2", excerpt: "we find that the block size 16 is large enough to efficiently utilize the GPU and small enough to avoid significant internal fragmentation in most workloads"}} The authors found this strikes the right balance - large enough to efficiently utilize GPU parallelism when reading and processing blocks, but small enough to minimize internal fragmentation and maximize sharing opportunities.

**MAYA:** Second question: When vLLM runs out of GPU memory and needs to evict some requests, what policy does it use to decide which requests to remove? Consider both fairness and implementation simplicity.

**ERIC:** vLLM uses a first-come-first-serve (FCFS) policy with all-or-nothing eviction. {{page: 21, section: "4.5", excerpt: "In vLLM, we adopt the first-come-first-serve (FCFS) scheduling policy for all requests, ensuring fairness and preventing starvation"}} It evicts entire requests rather than individual blocks, and always serves earlier-arrived requests first while evicting the most recent ones. This ensures fairness and prevents starvation while being simple to implement.

## Looking Forward

**MAYA:** The impact of this work extends beyond just serving existing models more efficiently. Better memory management could enable larger models to be served on smaller hardware, democratizing access to powerful language models.

**ERIC:** It also opens up possibilities for more complex serving scenarios. When memory isn't the bottleneck, you can experiment with more sophisticated decoding algorithms, longer contexts, or serving multiple models simultaneously.

**MAYA:** The authors mention that GPU compute capability is growing faster than memory capacity. An NVIDIA H100 has twice the compute power of an A100 but the same 80GB memory limit. This trend makes memory management techniques like PagedAttention even more critical for future systems. {{page: 12, section: "3", excerpt: "given the current trends, the GPU's computation speed grows faster than the memory capacity"}}

**ERIC:** From a research perspective, this paper is a nice reminder that sometimes the best solutions come from adapting well-understood concepts from other domains. Virtual memory has been around for decades, but applying it to transformer serving was genuinely novel and impactful.

## Conclusion

**MAYA:** The PagedAttention paper represents a perfect marriage of systems thinking and machine learning. By recognizing that LLM serving is fundamentally a memory management problem, the authors were able to adapt classical operating systems techniques to achieve dramatic performance improvements.

**ERIC:** What I find most elegant is how the solution addresses multiple problems simultaneously. PagedAttention reduces fragmentation, enables memory sharing, supports preemption, and handles variable-length sequences all through one unified approach.

**MAYA:** For anyone working on LLM infrastructure, this paper is essential reading. It shows how thoughtful systems design can unlock significant performance gains without requiring new hardware or model architectures.

**ERIC:** The broader lesson is about the importance of understanding your bottlenecks. The authors identified that memory, not computation, was limiting LLM serving throughput, and they designed their solution accordingly.

**MAYA:** As language models continue to grow and become more widely deployed, efficient serving systems like vLLM will be crucial for making AI accessible and affordable.

**ERIC:** That wraps up our deep dive into PagedAttention and vLLM. This paper brilliantly demonstrates how classical computer science can solve cutting-edge AI challenges through clever memory management.

**MAYA:** Until next time, keep strolling.

**ERIC:** And may your gradients never explode.