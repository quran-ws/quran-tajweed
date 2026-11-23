/**
 * The engine: given Quranic text, report where each rule of the corpus applies.
 *
 * The output is offsets, never markup. Rendering differs per platform and per
 * purpose — a mushaf page, a teaching aid, a terminal, a research query — and an
 * engine that returns HTML is useful only to the last person who needed HTML.
 */

import { compileRule, FOCUS_GROUP } from './compile.js'
import { normalize, type Normalized } from './normalize.js'
import { toSourceRange } from './mapped.js'
import {
  ALEF,
  DAMMA,
  DAMMATAN,
  FATHA,
  FATHATAN,
  FATHATAN_VERTICAL,
  INVERTED_DAMMA,
  KASRA,
  KASRATAN,
  OPEN_DAMMATAN,
  OPEN_FATHATAN,
  OPEN_KASRATAN,
  RECTANGULAR_ZERO,
  ROUNDED_ZERO,
  SHADDA,
  SMALL_HIGH_MEEM,
  SUKOON,
  SMALL_LOW_MEEM,
  SUBSCRIPT_ALEF,
  isStackedMark,
  toCodePoints,
} from './unicode.js'
import type { Corpus, Rule, Span } from './types.js'

export interface TajweedOptions {
  /**
   * Restrict matching to these rules, ahkam, categories or topics. Ids at any
   * level of the hierarchy are accepted. Omit to use every stable rule.
   */
  readonly only?: readonly string[]
  /**
   * Where two scholars are modelled as separate ahkam, keep only this school's.
   * Ahkam with no school attribution are always kept.
   */
  readonly school?: string
  /**
   * Include rules marked `disabled`. They are disabled because the notation
   * cannot express them and they are known to match wrongly or not at all —
   * this exists for working ON the corpus, not for reading with it.
   */
  readonly includeDisabled?: boolean
}

interface Prepared {
  readonly rule: Rule
  readonly pattern: RegExp
  readonly hukumId: string
  readonly categoryId: string
  readonly topicId: string
}

export class Tajweed {
  private readonly prepared: readonly Prepared[]

  private readonly cache = new Map<string, Normalized>()

  private readonly byRuleId = new Map<string, Prepared>()

  constructor(
    private readonly corpus: Corpus,
    options: TajweedOptions = {},
  ) {
    const categoryById = new Map(corpus.categories.map((category) => [category.id, category]))
    const hukumById = new Map(corpus.hukums.map((hukum) => [hukum.id, hukum]))

    const selected = new Set(options.only ?? [])
    const prepared: Prepared[] = []

    for (const rule of corpus.rules) {
      if (rule.status === 'disabled' && !options.includeDisabled) {
        continue
      }

      const hukum = hukumById.get(rule.hukum)
      if (!hukum) {
        throw new Error(`Rule ${rule.id} references unknown hukum ${rule.hukum}`)
      }
      const category = categoryById.get(hukum.category)
      if (!category) {
        throw new Error(`Hukum ${hukum.id} references unknown category ${hukum.category}`)
      }

      if (options.school && hukum.school && hukum.school.id !== options.school) {
        continue
      }

      const lineage = [rule.id, hukum.id, category.id, category.topic]
      if (selected.size > 0 && !lineage.some((id) => selected.has(id))) {
        continue
      }

      prepared.push({
        rule,
        pattern: compileRule(rule),
        hukumId: hukum.id,
        categoryId: category.id,
        topicId: category.topic,
      })
    }

    this.prepared = prepared
    for (const entry of prepared) {
      this.byRuleId.set(entry.rule.id, entry)
    }
  }

  /** The rules this instance will match with, after filtering. */
  get rules(): readonly Rule[] {
    return this.prepared.map((entry) => entry.rule)
  }

  get riwayah(): string {
    return this.corpus.riwayah
  }

  /**
   * Finds every occurrence of every selected rule in `ayahText`.
   *
   * Spans may overlap — a single letter can demonstrate more than one ruling, and
   * deciding which to show is a presentation question. Use `resolveOverlaps` when
   * a single non-overlapping layer is needed.
   */
  analyze(ayahText: string): Span[] {
    const normalized = this.normalized(ayahText)
    const spans: Span[] = []

    for (const entry of this.prepared) {
      // A rule declaring `original` is written against the text as the mushaf
      // has it, so its match offsets are already the caller's offsets and need
      // no mapping back.
      const onOriginal = entry.rule.matchAgainst === 'original'
      const subject = onOriginal ? ayahText : normalized.text

      entry.pattern.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = entry.pattern.exec(subject)) !== null) {
        // `match.index` is a UTF-16 index; the map is indexed by code point.
        // They differ only outside the Basic Multilingual Plane, which Quranic
        // text does not reach.
        const start = codePointIndex(subject, match.index)
        const end = start + toCodePoints(match[0]).length

        const range = onOriginal
          ? { start, end }
          : toSourceRange(normalized, start, end, normalized.sourceLength)

        // The focus capture, mapped back the same way as the span.
        const capture = match.indices?.groups?.[FOCUS_GROUP]
        let focus = { start: range.start, end: range.end }
        if (capture) {
          const focusStart = codePointIndex(subject, capture[0])
          const focusEnd = codePointIndex(subject, capture[1])
          focus = onOriginal
            ? { start: focusStart, end: focusEnd }
            : toSourceRange(normalized, focusStart, focusEnd, normalized.sourceLength)
        }
        if (entry.rule.focusStartsAt === 'tanween') {
          focus = atTanween(ayahText, focus, entry.rule.focus)
        }
        // A rule across two words is about reading on into the next word, and an alef
        // marked ۠ (أَنَا۠، لَّٰكِنَّا۠) is not read when the reading goes on. Such a
        // letter cannot be the madd of المد المنفصل.
        const silent = entry.rule.scope === 'across-words' && carriesSilentAlefMark(ayahText, focus)

        if (!silent) {
          spans.push({
            ...range,
            focusStart: focus.start,
            focusEnd: focus.end,
            ruleId: entry.rule.id,
            hukumId: entry.hukumId,
            categoryId: entry.categoryId,
            topicId: entry.topicId,
          })
        }

        // A pattern that can match empty would otherwise loop forever.
        if (match[0].length === 0) {
          entry.pattern.lastIndex += 1
        }
      }
    }

    spans.sort((a, b) => a.start - b.start || b.end - a.end || a.ruleId.localeCompare(b.ruleId))
    return spans
  }

  /** True if any selected rule matches — cheaper than `analyze` when counting. */
  matches(ayahText: string, ruleId: string): boolean {
    const entry = this.byRuleId.get(ruleId)
    if (!entry) {
      return false
    }
    entry.pattern.lastIndex = 0
    return entry.pattern.test(
      entry.rule.matchAgainst === 'original' ? ayahText : this.normalized(ayahText).text,
    )
  }

  private normalized(ayahText: string): Normalized {
    let cached = this.cache.get(ayahText)
    if (!cached) {
      cached = normalize(ayahText)
      this.cache.set(ayahText, cached)
    }
    return cached
  }
}

/**
 * Every character an edition writes a tanween with: the standalone tanween, and
 * the positional and open forms the normaliser folds onto it (normalize.ts).
 */
const TANWEEN = new Set([
  FATHATAN, DAMMATAN, KASRATAN,
  INVERTED_DAMMA, FATHATAN_VERTICAL, SUBSCRIPT_ALEF,
  OPEN_FATHATAN, OPEN_DAMMATAN, OPEN_KASRATAN,
])
const SMALL_MEEM = new Set([SMALL_HIGH_MEEM, SMALL_LOW_MEEM])
/** What may stand before the small meem of an إقلاب tanween: its haraka, and a shadda (غَمَّۢا). */
const BEFORE_SMALL_MEEM = new Set([FATHA, DAMMA, KASRA, SHADDA])

/**
 * Moves a focus to start at the tanween inside it. A focus of one group becomes
 * the tanween alone; a focus of more groups runs from the tanween to its end.
 *
 * Before ب the script writes the tanween of إقلاب as one haraka and a small
 * meem (مُۢ), with no tanween character; there the haraka and the meem are the
 * tanween. Left as it is if the focus holds neither.
 */
function atTanween(
  text: string,
  focus: { start: number; end: number },
  groups: readonly [number, number] | undefined,
): { start: number; end: number } {
  const chars = toCodePoints(text)
  const single = !groups || groups[0] === groups[1]
  // Normalisation reorders a shadda and its tanween (حَقࣲّ), so the focus mapped
  // back can stop before a tanween written after the shadda. Search on through
  // the marks still on the same letter.
  let limit = focus.end
  while (limit < chars.length && isStackedMark(chars[limit])) {
    limit += 1
  }
  for (let index = focus.start; index < limit; index += 1) {
    if (TANWEEN.has(chars[index]!)) {
      return { start: index, end: single ? index + 1 : Math.max(focus.end, index + 1) }
    }
  }
  for (let index = focus.start; index < limit; index += 1) {
    if (SMALL_MEEM.has(chars[index]!)) {
      let start = index
      while (start > focus.start && BEFORE_SMALL_MEEM.has(chars[start - 1]!)) {
        start -= 1
      }
      return { start, end: single ? index + 1 : Math.max(focus.end, index + 1) }
    }
  }
  return focus
}

/**
 * True if the focus's first letter carries a mark saying it is not read when the
 * reading continues: ۠ (U+06E0, أَنَا۠) or ۟ (U+06DF), or, on an alef, the round
 * sukun U+0652 (نَبۡلُوَاْ) — the KFGQPC text writes a real sukun as U+06E1, and a
 * madd alef never carries one. Only the first letter's own marks count: in
 * قَالُوٓا۟ the ۟ is on the alef after the madd letter, and the madd is real.
 */
function carriesSilentAlefMark(text: string, focus: { start: number; end: number }): boolean {
  const chars = toCodePoints(text)
  const onAlef = chars[focus.start] === ALEF
  const silent = (char: string | undefined): boolean =>
    char === RECTANGULAR_ZERO || char === ROUNDED_ZERO || (onAlef && char === SUKOON)
  for (let index = focus.start + 1; index < chars.length; index += 1) {
    if (silent(chars[index])) {
      return true
    }
    if (!isStackedMark(chars[index])) {
      return false
    }
  }
  return false
}

/**
 * Narrows each span to its focus: the letter or letters the ruling is about,
 * without the letters that only trigger it.
 *
 * A span is the whole match, so for قلقلة صغرى in أَبۡصَٰرِهِمۡ it is بۡص, and
 * colouring the span colours the ص that merely follows. Renderers colour the
 * focus. Spans keep their full extent as data, because the condition is part of
 * what was found.
 */
export function toFocus(spans: readonly Span[]): Span[] {
  return spans.map((span) =>
    span.focusStart === span.start && span.focusEnd === span.end
      ? span
      : { ...span, start: span.focusStart, end: span.focusEnd },
  )
}

/**
 * Reduces overlapping spans to a single non-overlapping layer, keeping the
 * earliest span and, where two start together, the longer one.
 *
 * This is a rendering convenience, not a ruling: dropping a span does not mean
 * that rule does not apply, only that something else is drawn there. Anything
 * teaching tajweed should show the overlaps rather than hide them.
 */
export function resolveOverlaps(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Span[] = []
  let lastEnd = -1

  for (const span of ordered) {
    if (span.start >= lastEnd) {
      kept.push(span)
      lastEnd = span.end
    }
  }

  return kept
}

/**
 * Extracts the text a span covers, correctly for any code point.
 *
 * Exactly the span, and deliberately so: this is the data accessor, and what it
 * returns has to agree with `start`, `end` and anything counted from them.
 *
 * That is not the same as what a renderer should cut. A span ends on the letter
 * its ruling concerns, which may be written before the shadda or harakah it
 * carries, so a slice taken for DISPLAY beside the rest of the ayah should push
 * the end past those marks first:
 *
 * ```ts
 * sliceSpan(text, { start: span.start, end: clusterEnd(text, span.end) })
 * ```
 *
 * `clusterEnd` and `bridgeJoins` are the two halves of drawing a cut ayah; see
 * docs/rendering.md.
 */
export function sliceSpan(ayahText: string, span: Pick<Span, 'start' | 'end'>): string {
  return toCodePoints(ayahText).slice(span.start, span.end).join('')
}

/** Converts a UTF-16 index into a code-point index. */
function codePointIndex(text: string, utf16Index: number): number {
  let count = 0
  for (let i = 0; i < utf16Index; ) {
    const code = text.codePointAt(i)!
    i += code > 0xffff ? 2 : 1
    count += 1
  }
  return count
}
