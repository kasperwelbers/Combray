# AI helper

Combray includes an optional assistant that participants (and facilitators) can talk to. It has two jobs:

1. **Help**: answer questions about the process. "How do I download my Google Takeout?" "Why is my TikTok export a zip with two files?" "What happens to my data if I donate?"
2. **Tasks**: plan small analyses that run on the participant's device. "Find data about my music interests and visualise it." "When did I start watching cooking videos?"

## The core rule: the AI never sees the data

The model never receives participant data. Not rows, not titles, not URLs, not samples, not even with consent. It only sees **structure metadata** and **non-sensitive local results**, and it responds with **instructions** that the client executes locally.

```
   participant ──question──► AI model
                               │  sees: shapes (keys, types, counts in buckets),
                               │        dataset and field names, local classifier
                               │        labels that are non-sensitive by design
                               ▼
                         instructions (queries, plugin runs, view specs)
                               │
                               ▼
   client (local workers) ─ executes on real data ─► view shown to participant only
```

The participant sees the result; the model does not. The model is told only whether an instruction succeeded and, where needed, structural facts about the result (e.g. "a view with 20 rows was created", "field `genre` now exists with 14 categories from the `music-genre` classifier").

What may go to the model:

- **Shapes** as defined in [universal-importer.md](universal-importer.md#structure-metadata): file and key names (after dictionary collapsing and name screening), node kinds, value types, bucketed counts, HTML tag/id/class.
- **Dataset descriptions**: dataset names, field names and types, time range at coarse granularity (year), bucketed sizes.
- **Non-sensitive classifier outputs**: the label set of a local classifier and, where the study allows it, aggregate counts per label at coarse buckets (e.g. "music: many, news: few"). Classifier plugins declare in their manifest whether their labels are safe to share, and the study config must enable this explicitly.
- **Help knowledge**: platform instructions and Combray documentation.

What never goes to the model: values, items, titles, URLs, search queries, usernames, free-text annotations, or any output of a classifier that is not declared safe.

This is enforced in one place, the helper's context builder in the client, which only accepts typed metadata objects (shapes, dataset descriptions, declared-safe aggregates) and has no API for passing arbitrary values. It is covered by tests that run tasks on synthetic data with canary strings and assert that no canary reaches the outgoing request.

### Opening message

The helper introduces itself with this promise up front, for example:

> Hi, I'm here to help. You can ask me how to collect your data and how to explore it. Rest assured that I can never see your data myself! ([How does that work?](#))

The link opens a short, plain-language explanation of the diagram above, with a technical appendix for those who want it.

## Tools (instructions the model can give)

The model works by emitting instructions that the client validates and runs locally:

| Instruction | Runs locally | Model gets back |
| --- | --- | --- |
| `list_datasets` | reads the encrypted store index | dataset names, field names and types, bucketed sizes |
| `describe_shape(dataset or file)` | shape extraction | the shape |
| `run_query(dataset, group_by, metric, filter)` | query worker | success, number of rows (bucketed), field names of the result |
| `run_plugin(dataset, field, plugin)` | sandbox worker (e.g. a music classifier) | new field name, label set, declared-safe aggregates |
| `create_view(spec)` | renders a Vega-Lite or Combray view for the participant | success or validation error |
| `ask_participant(question)` | shows a question in the UI | the participant's answer only if they choose to type something to the helper |
| `help_search(query)` | searches the help knowledge base | passages |

Filters in `run_query` are written by the model in terms of fields and operators, without knowing the values. For example, "music" is not something the model can detect from titles; it asks the client to run a local classifier and then filters on the classifier's label.

The participant can type anything in the chat, and of course a participant might describe their own data in their words. The UI makes clear that what they type is sent to the model, and the helper never asks them to paste data.

Example: "find data about my music interests and visualise it" might become `list_datasets` → sees YouTube and Spotify datasets with a `title` and `artist` field → `run_plugin(youtube/watch-history, title, music-detector)` → `run_query(group_by: artist, metric: count, filter: music-detector = music, top: 20)` → `create_view(top-items)` → "I've made a list of the artists you listened to most. Take a look: do any of them surprise you?" The model never learns who the artists are.

## Model hosting

Because the model sees only metadata, hosting is a smaller privacy question than usual, but still a choice per study:

- **Local models** in a lab deployment (llama.cpp or Ollama in the compose stack), so nothing leaves the lab network.
- **Remote models through the server**, for example Claude via the Anthropic API, through the Combray server's `/assistant` proxy, so API keys never reach the browser. The study config states which provider is used.
- **In-browser models** via WebGPU (e.g. WebLLM) are an option for help-only use.

## Research integrity

In qualitative research, the assistant could steer what participants say about their own lives. Studies need control over this:

- The helper can be disabled, limited to help only, or allowed to do tasks.
- Researchers can set a system prompt that keeps the helper neutral and descriptive (it helps find and show data, it does not interpret the participant's life for them).
- Helper conversations are stored locally like other annotations and can be included in the donation with consent, so researchers can see what the helper said.

## Help knowledge base

The download instructions in DigitalFootprintsLab (`googleTakeoutInstruction`, `tiktokTakeoutInstruction`) become part of **platform packs**: step-by-step instructions with screenshots per language, shown directly in the UI and also used as the helper's knowledge base. Keeping them as structured content means they can be updated without a code change when a platform changes its download page.

## Open questions

- Which providers to support first: a local model through an OpenAI-compatible endpoint (llama.cpp, Ollama, vLLM), the Anthropic API, or both? Recommendation: both, behind one small provider interface on the server.
- Which classifier outputs count as non-sensitive? A topic label like "music" seems safe; labels like "health" or "religion" may themselves be special-category data under GDPR. Proposal: plugins declare safe labels, and studies can only share labels from that list.
- Should even the coarse aggregate counts per label be shared with the model, or only the label set?
- Is a browser-only (WebGPU) model good enough for help, or does it add too much download weight for participants?
- How do ethics committees view an AI helper in interviews? We should prepare a short description for applications.
