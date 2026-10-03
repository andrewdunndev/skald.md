// Obsidian code reaches timers through `window` for popout-window support;
// plain Node has no `window`, so alias it to the global object.
(globalThis as { window?: unknown }).window ??= globalThis;
