import type { Scope } from './compile.js'

export interface Label {
  readonly ar: string
  readonly [language: string]: string
}

export interface Topic {
  readonly id: string
  readonly label: Label
}

export interface Category {
  readonly id: string
  readonly topic: string
  readonly label: Label
  readonly empty?: boolean
}

export interface Hukum {
  readonly id: string
  readonly category: string
  readonly label: Label
  readonly school?: { readonly id: string; readonly scholar: string }
}

export type RuleStatus = 'stable' | 'disputed' | 'disabled'

export interface Rule {
  readonly id: string
  readonly hukum: string
  readonly case: string
  readonly scope: Scope
  /** Which text the pattern is written against. Defaults to `normalized`. */
  readonly matchAgainst?: 'normalized' | 'original'
  readonly status: RuleStatus
  readonly gap?: string
  readonly statusReason?: string
  readonly needsReview?: boolean
  /**
   * A qualified reader has questioned this RULING, and it is unresolved.
   *
   * Distinct from `needsReview`, which means nobody has looked yet. This means
   * somebody looked and disagreed. It is recorded on the rule so the objection
   * travels with the thing it is about instead of living in a review thread,
   * and `validate-rules.ts` refuses to let a rule carry an open one while
   * claiming `status: "stable"`.
   *
   * Carrying this does NOT remove the rule's spans: the engine excludes
   * `disabled` and nothing else. Whether a questioned ruling should still be
   * published is a scholarly decision, not a schema one.
   */
  readonly disputed?: {
    readonly finding: string
    readonly raised_by: string
    /** Every place it fires, by reference. A list, never a count. */
    readonly occurrences: readonly string[]
    readonly resolved_by?: string
  }
  readonly corrections?: ReadonlyArray<{ field: string; was: string; reason: string }>
  readonly label: Label
  readonly notes?: Label
  readonly startFrom?: string
  /**
   * The groups of `case`, as an inclusive `[from, to]` range of indices, that
   * hold the letter or letters the ruling is about. The other groups are the
   * condition that triggers it: in `[قْ طْ بْ جْ دْ] + غير مدغم + [...]` the
   * focus is `[0, 0]`, the qalqalah letter, and the letter after it only
   * qualifies the match. Rules about two letters together (idgham, ikhfa,
   * iqlab, izhar) cover both. Absent on single-group rules, whose whole match
   * is the focus.
   */
  readonly focus?: readonly [number, number]
}

export interface Corpus {
  readonly version: string
  readonly riwayah: string
  readonly topics: readonly Topic[]
  readonly categories: readonly Category[]
  readonly hukums: readonly Hukum[]
  readonly rules: readonly Rule[]
}

/**
 * One occurrence of one rule in a piece of text.
 *
 * `start` and `end` are half-open CODE-POINT offsets into the exact string that
 * was passed to `analyze` — not into the engine's internal normalised form, and
 * not byte or UTF-16 offsets. For text confined to the Basic Multilingual Plane,
 * which includes all Arabic and all Quranic annotation marks, they coincide with
 * JavaScript string indices; `sliceSpan` handles the general case.
 */
export interface Span {
  readonly start: number
  readonly end: number
  /**
   * The part of the span the ruling is about, in the same code-point offsets:
   * the rule's `focus` groups. Equal to `start`/`end` for a rule without a
   * focus. Colour this, not the whole span; the rest is the condition.
   */
  readonly focusStart: number
  readonly focusEnd: number
  readonly ruleId: string
  readonly hukumId: string
  readonly categoryId: string
  readonly topicId: string
}
