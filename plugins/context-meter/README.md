# bb-plugin-context-meter

Adds a **Context** section to bb's thread context card (the panel pinned at the top right of each thread): used / total tokens, a stacked bar per category, and the breakdown bb records (system prompt, tools, memory files, skills, messages, autocompact buffer, free space, and what is available on demand). It refreshes every 5 seconds while the window is visible.

Requires the card: `bb settings experiment threadContextCard true`. The card floats only when the thread is opened as a page in a wide enough pane; elsewhere bb opens it from the header button.

The breakdown appears once the provider has recorded a snapshot; until then only the total is shown. *Hide details* is remembered per browser in `localStorage`.
