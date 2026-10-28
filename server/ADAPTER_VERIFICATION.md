# Browser adapter verification

2026-10-27, Windows Microsoft Edge, authenticated persistent browser profile. No external messages, likes, follows, or login submissions were made during this verification.

- A keyword search initially reached the platform's verification page. The adapter now recognizes verification in the document title, preserves the tab and reports manual interaction required. Verification was completed separately by the parent agent through the visible browser.
- The completed search page contained 25 public work links. Reusing it, the real adapter selected works, read comments, extracted the native comment identifier, read emoji alt text and opened a commenter's public profile. A comment about a 50 square metre loft's renovation cost was obtained with matching source author and profile nickname. Sanitized local evidence is in `.data/adapter-readonly/comment-results.json`; source screenshots are in `.data/evidence`.
- Actual comments use `[data-e2e="comment-item"]`; author text links are `.comment-item-info-wrap a`, while the first generic link is an avatar and has no nickname. Visible original text is the next sibling of `.comment-item-info-wrap`. The platform's native comment identifier was visible on a `tooltip_<id>` element.
- Native comment Reply was opened without typing. Its Draft editor is `.public-DraftEditor-content`; `aria-describedby` points to the precise `回复@<nickname>` placeholder. No comment reply was sent in this development verification.
- Private message target verification was tested without typing or sending. The native header title is `.StackLayoutStackChatHeadertitle`, and clicking its avatar opens the actual public profile. The adapter waits for the popup's `/user/` URL before comparing the stable platform identifier. The real helper returned true for the intended target. Sanitized outcome is in `.data/adapter-readonly/identity-regression.json`.
- The previously sampled music live room had ended during this later verification; the adapter correctly reported that state. Isolated local browser tests cover misbound live profiles, correct source ownership and screenshot association.

`python -m unittest server.tests.test_adapter -v` uses local, routed HTML pages only. Tests cover stable identity vs nickname, URL boundaries, wrong conversation rejection, same-name different-platform-ID rejection, actual local DOM send echo, unknown send state when only the input clears, and both live identity binding outcomes. These tests never send to Douyin.

Selectors can change with platform UI updates. Missing evidence or unavailable native actions fail explicitly; they do not produce invented records or success receipts.
