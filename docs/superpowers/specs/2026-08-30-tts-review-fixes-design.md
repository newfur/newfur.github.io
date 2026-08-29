# TTS Review Fixes Design

## Scope

Fix the three TTS regressions identified in the code review:

- Keep unmatched-language fallback voices out of the recommended group and avoid duplicate options.
- Use chapter titles only when no body-text sample is available for language detection.
- Make Edge-only mode exclude non-Edge voices consistently, including when the target language has no Edge voice.

## Design

`initTTSPanelVoices` will use a real language match set for the recommended group and a separately filtered complete list for fallback/other voices. A voice will be rendered exactly once. When no target-language voice exists, the first available voice is selected as a fallback without presenting it as recommended.

`detectBookLanguage` will append chapter titles only when the body sample is empty, preserving body content as the highest-confidence source.

When Edge-only mode is enabled, the complete source list will be filtered to Edge voices before recommendation and other-voice grouping. If no Edge voice exists, the selector will remain empty rather than violating the setting.

The source implementation remains the single source of truth; the generated `index.html` and `reader_offline.html` files will be rebuilt with `npm run build:offline`.

## Verification

Add a Node regression test for the pure grouping and language-sample decisions, run it red before implementation and green afterward. Also run the existing build, syntax checks, and `git diff --check`.
