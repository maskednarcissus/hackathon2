# Student Web: WCAG 2.2 AA Audit (Phase 3, deliverable 3.17)

- **App:** `apps/student-web` (Next.js 15, pt-BR)
- **Audit date:** 2026-11-04
- **Scope:** every student page. Each page was checked at 375 × 812 (mobile) and 1280 × 900 (desktop), in light and dark colour schemes: 13 pages × 2 viewports × 2 schemes = 52 runs.
- **Status:** the automated checks pass on all 52 runs. A manual screen-reader pass and a full axe-core run are **still pending** (see §4).

## 1. Method

The audit ran against the production build (`next build && next start`). Upstream services were replaced by a local
mock that returns realistic contract-shaped data, so the pages rendered real content instead of error states. The
session cookie held a test access token.

**Automated with Playwright/Chromium.** The script is `docs/accessibility/student-web-audit-script.js`; axe-core
could not be installed because no new dependencies were allowed. It checks:

| Check                                                                                   | WCAG SC             |
| --------------------------------------------------------------------------------------- | ------------------- |
| `html[lang]` present                                                                    | 3.1.1               |
| exactly one `h1`; no skipped heading levels                                             | 1.3.1, 2.4.6        |
| `<main>` landmark present                                                               | 1.3.1, 2.4.1        |
| `img` has `alt`                                                                         | 1.1.1               |
| every visible form control has a programmatic label                                     | 1.3.1, 3.3.2, 4.1.2 |
| every link/button has an accessible name                                                | 2.4.4, 4.1.2        |
| interactive targets ≥ 24 × 24 CSS px (inline text links excluded per SC exception)      | 2.5.8               |
| no horizontal scrolling at 375 px                                                       | 1.4.10              |
| text contrast ≥ 4.5:1 (≥ 3:1 for large text), computed from the rendered colours        | 1.4.3               |
| visible focus indicator on the first 15 Tab stops, and the focused element is on screen | 2.4.7, 2.4.11       |

**Interaction checks (Playwright):**

- report dialog opens, submits, announces success and returns focus to its trigger on `Esc`;
- the `?t=` transcript deep link focuses the correct segment;
- assistant answers render "Dito em aula" and "Explicação gerada por IA" labels plus citations, and the feedback status is announced;
- the login error appears in a `role="alert"` region.

## 2. Findings and fixes (first automated run)

| #   | Finding                                                                             | SC                | Fix                                                            |
| --- | ----------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| 1   | 2 px horizontal scroll at 375 px, caused by the header (brand + three icon buttons) | 1.4.10            | brand truncates with ellipsis; header actions no longer shrink |
| 2   | Unread-count badge: white on light-red in dark mode (2.0:1)                         | 1.4.3             | new `--danger-contrast` token (dark text in dark mode): 8.99:1 |
| 3   | Native date input: the picker sub-control showed no focus outline                   | 2.4.7             | `input:focus-within` outline on all form controls              |
| 4   | "Ver trecho da aula" link was 22 px tall inside a flex row                          | 2.5.8             | links in `.btn-row` get `min-height: 24px`                     |
| 5   | CSS `text-transform: capitalize` produced "Novembro De 2026" (wrong pt-BR casing)   | 3.1 (readability) | casing done in code with `capitalizeFirst`                     |

All checks passed on the second run (52/52).

## 3. Design-token contrast (computed)

| Pair                                                                     | Ratio                       |
| ------------------------------------------------------------------------ | --------------------------- |
| `text` #17212f on `bg` #f6f8fa                                           | 15.23:1                     |
| `text-2` #475569 on `bg` #f6f8fa                                         | 7.12:1                      |
| `text-2` #475569 on `surface-2` #eef2f6                                  | 6.74:1                      |
| `accent` #1e5a92 on `surface` #ffffff                                    | 7.16:1                      |
| `accent-contrast` #ffffff on `accent` #1e5a92                            | 7.16:1                      |
| `success` #0f6b47 on `success-bg` #e3f4ec                                | 5.73:1                      |
| `warning` #7a4f00 on `warning-bg` #fdf1dc                                | 6.38:1                      |
| `danger` #a33131 on `danger-bg` #fbe7e7                                  | 5.82:1                      |
| `danger-contrast` #ffffff on `danger` #a33131                            | 6.91:1                      |
| `info` #1f5f94 on `info-bg` #e3eef8                                      | 5.72:1                      |
| `ai` #5b3d99 on `ai-bg` #efe9fa                                          | 6.88:1                      |
| `mark-text` #17212f on `mark-bg` #fff1a8                                 | 14.21:1                     |
| `border-strong` #6b7a8c on `surface` #ffffff (UI component, needs ≥ 3:1) | 4.39:1                      |
| focus ring #1e5a92 on `bg` (needs ≥ 3:1)                                 | 6.73:1                      |
| dark `text` #e8eef5 on `bg` #0f1722                                      | 15.42:1                     |
| dark `text-2` #b4c0ce on `surface` #17212f                               | 8.78:1                      |
| dark `accent` #8cc4ff on `surface` #17212f                               | 8.85:1                      |
| dark `accent-contrast` #0f1722 on `accent` #8cc4ff                       | 9.82:1                      |
| dark `success` / `warning` / `danger` / `ai` on their tinted backgrounds | 7.86 / 8.41 / 7.71 / 8.19:1 |
| dark `danger-contrast` #0f1722 on `danger` #ff9c9c                       | 8.99:1                      |
| dark `mark` #fffbe0 on #6b5b00                                           | 6.45:1                      |
| dark `border-strong` #8393a7 on `surface` (UI)                           | 5.17:1                      |

The original `packages/ui/tokens.css` `--text-secondary` #64748B on #F6F8FA is about 4.4:1, which fails AA for body
text. The student web therefore uses its own `--text-2` #475569.

## 4. Success-criteria checklist (per page)

Legend: ✅ verified (automated or by code review) · 🔶 implemented, manual verification pending · n/a not applicable.

Pages: E = /entrar · H = / · L = /aulas · D = /aulas/[id] · T = /aulas/[id]/transcricao · B = /busca · C = /calendario (month/week/agenda) · V = /calendario/[id] · A = /assistente · N = /notificacoes · P = /preferencias

| SC     | Requirement               | E   | H   | L   | D   | T   | B   | C   | V   | A   | N   | P   | Notes                                                                                                            |
| ------ | ------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---------------------------------------------------------------------------------------------------------------- |
| 1.1.1  | Non-text content          | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | icons are `aria-hidden`; icon buttons carry `aria-label`                                                         |
| 1.3.1  | Info & relationships      | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | landmarks, `dl` for concepts, `table`+`caption`+`scope` in month grid and preferences, `fieldset/legend`         |
| 1.3.2  | Meaningful sequence       | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | DOM order = visual order; mobile bottom nav after `main`                                                         |
| 1.3.4  | Orientation               | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | no orientation lock                                                                                              |
| 1.3.5  | Identify input purpose    | ✅  | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | `autocomplete=username/current-password`                                                                         |
| 1.4.1  | Use of colour             | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | every status badge has text; mobile month chips have hidden text plus cancellation strike-through                |
| 1.4.3  | Contrast (minimum)        | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | §3; automated in light and dark                                                                                  |
| 1.4.4  | Resize text 200 %         | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | rem-based type; manual zoom test pending                                                                         |
| 1.4.10 | Reflow (320 px)           | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | automated at 375 px; 320 px pending manual                                                                       |
| 1.4.11 | Non-text contrast         | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | control borders 4.39:1 and focus ring 6.73:1                                                                     |
| 1.4.12 | Text spacing              | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | 🔶  | no fixed-height text containers except month cells (overflow visible); manual bookmarklet test pending           |
| 1.4.13 | Content on hover/focus    | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | no custom tooltips (`title` only on month chips)                                                                 |
| 2.1.1  | Keyboard                  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | native controls only; `dialog` handles Esc and focus trap; Enter sends in the assistant (Shift+Enter = new line) |
| 2.1.2  | No keyboard trap          | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |                                                                                                                  |
| 2.2.1  | Timing adjustable         | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | silent token refresh, so no session-timeout interruption                                                         |
| 2.3.1  | Three flashes             | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | only the skeleton shimmer, disabled under `prefers-reduced-motion`                                               |
| 2.4.1  | Bypass blocks             | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | skip link to `#conteudo`                                                                                         |
| 2.4.2  | Page titled               | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | `%s · Classroom Intelligence`                                                                                    |
| 2.4.3  | Focus order               | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | dialog returns focus to its trigger (verified)                                                                   |
| 2.4.4  | Link purpose              | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | timestamp links have spoken labels ("Link para 1 minuto e 15 segundos")                                          |
| 2.4.6  | Headings & labels         | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |                                                                                                                  |
| 2.4.7  | Focus visible             | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | 3 px ring; automated over 15 Tab stops per page                                                                  |
| 2.4.11 | Focus not obscured (min.) | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | `scroll-padding-top` clears the sticky header; bottom nav: 🔶 manual check on long pages                         |
| 2.5.3  | Label in name             | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | "Reportar" visible text starts its aria-label                                                                    |
| 2.5.7  | Dragging movements        | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | no drag interactions                                                                                             |
| 2.5.8  | Target size (min.)        | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | automated                                                                                                        |
| 3.1.1  | Language of page          | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | `lang="pt-BR"`                                                                                                   |
| 3.2.2  | On input                  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | filters apply only on submit                                                                                     |
| 3.2.6  | Consistent help           | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | assistant and report entry points in consistent places                                                           |
| 3.3.1  | Error identification      | ✅  | n/a | n/a | ✅  | ✅  | n/a | ✅  | ✅  | ✅  | n/a | ✅  | `role="alert"` messages in text                                                                                  |
| 3.3.2  | Labels or instructions    | ✅  | n/a | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | n/a | ✅  |                                                                                                                  |
| 3.3.7  | Redundant entry           | ✅  | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |                                                                                                                  |
| 3.3.8  | Accessible authentication | ✅  | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | password managers and paste allowed; no cognitive test                                                           |
| 4.1.2  | Name, role, value         | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | `aria-current` on nav and view switch; `aria-pressed` on feedback                                                |
| 4.1.3  | Status messages           | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  | `aria-live` for assistant progress, copy, save, report, result counts                                            |

## 5. Pending (not verifiable in this environment)

1. **axe-core run.** Add `@axe-core/playwright` to CI and run `student-web-audit-script.js` with `AxeBuilder`.
   It was not installed here (no new dependencies allowed).
2. **Manual screen-reader pass** with NVDA + Firefox, VoiceOver iOS + Safari and TalkBack + Chrome, on the
   assistant, calendar month grid, report dialog and transcript deep links.
3. 200 % / 400 % zoom, a text-spacing bookmarklet, and a 320 px viewport check.
4. Real-device checks: push permission flow and service worker on Android and iOS 16.4+ (PWA installed).
5. Re-run against real services once identity, lecture-intelligence, calendar and notifications are integrated.
   Long or unexpected content (very long titles, 200+ transcript segments) may surface new issues.
