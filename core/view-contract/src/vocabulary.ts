// THE VOCABULARY — what the ontology must say, and nothing the web platform
// already says better.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO RULES, AND THE SECOND ONE ARRIVED LATE
//
//   ① Borrow a vocabulary WHOLE. Cutting someone else's converged set to fit
//      the sample in front of you is how a vocabulary drifts: every addition is
//      defensible on its own, and together they never stop.
//
//   ② ⚠️ BUT BORROW ONLY WHAT BEARS LOAD. Some of a platform's vocabulary
//      exists because ITS users cannot write code. That part is not ours.
//
//   Rule ② was learned the hard way, one day after rule ①. An earlier version of
//   this file transcribed Palantir Foundry's entire value-formatting vocabulary:
//   five numeric bases, grouping, notation, four digit controls, six date
//   styles, timezone selection.
//
//   `Intl.NumberFormat` and `Intl.DateTimeFormat` ARE that API — standardised,
//   in every browser, more complete and never wrong. Foundry needs it declared
//   in the ontology because Workshop is drag-and-drop and its users have no
//   place to put code. We have a renderer written in code. We do not have that
//   problem, and importing the solution to a problem we do not have cost a page
//   of type definitions that could only ever be a worse `Intl`.
//
//   The test each entry below has to pass:
//
//     Does this decide whether the app's FRAME is rigid — the same field
//     meaning the same thing on every screen that shows it?
//
//   "This number is money" passes: shown three ways on three screens, it is a
//   defect. "This box is three rows tall" fails: that is `<textarea>`, and HTML
//   has owned it since 1995.
// ═══════════════════════════════════════════════════════════════════════════
//
//   ✅ resolved — the resolver reads it and puts it in the contract
//   📋 declared — part of the vocabulary, not yet resolved. Using one is an
//                 error, never silence: see `NOT_YET_RESOLVED`.

// ── What a value MEANS ────────────────────────────────────────────────────
//
// Not how it is written — what it is. The renderer picks the wording with
// `Intl` and the app's locale; the ontology only says which kind of number this
// is, because that answer must be the same on every screen.
//
// ⚠️ Deliberately two words, and it is not the same restraint that got cut
//    before. `linked · aggregate · math` was cut to fit one app's sample, and
//    two of the three were needed within a day. This list is short because
//    everything else that WOULD have been on it belongs to `Intl`.

/** ✅ Both resolved. */
export type ValueMeaning = 'currency' | 'percent'

/**
 * Visual weight of an enum value — `tone`, not colour.
 *
 * ⭐ This survives the cut where conditional formatting did not, and the
 *    difference is the whole point of rule ②. "This state is bad" is a fact
 *    about the state: PAID is done, needs_repair is a problem, and that is true
 *    on every screen. The renderer owns the palette.
 *
 *    What got cut was the RULE ENGINE around it — `when: { gt: 30 }` with icons
 *    and alignment. That is a few lines of JS in the renderer, and in a
 *    declaration it was on its way to becoming a small bad language.
 */
export type Tone = 'plain' | 'wait' | 'doing' | 'done' | 'warn' | 'stop'

// ── What the frame shows ──────────────────────────────────────────────────

/**
 * ✅ Which properties a list shows when the view does not say.
 *
 * Load-bearing: "worth showing" is a fact about the property, and three screens
 * over one entity used to answer it three times and drift apart.
 */
export type Visibility = 'prominent' | 'normal' | 'hidden'

/** ✅ `title` — the property that IS the record's name to a person. */
export type PropertyKey = 'title' | 'primary'

/**
 * ✅ How hard a column fights to stay when a table runs out of room.
 *
 * ⛔ THE MEASUREMENT THAT PROMPTED THIS WAS WRONG, AND THE CORRECTION IS WORTH
 *    MORE THAN THE ORIGINAL CLAIM.
 *
 *    Reported: *"679 columns across 56 screens — about twelve per table, one
 *    table with thirty-one."* Both halves are a UNIT ERROR. 679 `<th>` divided
 *    by 56 SCREENS is columns per screen, and a screen holds several tables.
 *    Counted per `<table>` block: **126 tables, mean 5.4 columns, median 5, and
 *    exactly two tables above eight** — the widest being a planning matrix whose
 *    seven numeric columns are the point of the screen.
 *
 *    There was no column problem. The remedy was designed for a defect that did
 *    not exist.
 *
 * ⭐ SO WHY IT STAYS, stated honestly: it is a FENCE, not a cure. "How important
 *    is this column" is still a fact about the PROPERTY rather than about a
 *    screen — a person's name outranks their last training date on every table
 *    showing both — and column counts only ever move one way as an ontology
 *    grows. Declaring it now costs a keyword; discovering it at forty columns
 *    costs a rewrite of every table.
 *
 * ⚠️ But nothing here should be read as evidence that tables are too wide today.
 *    They are not.
 *
 * ⚠️ NOT a width and NOT an order. Both of those are layout, and layout belongs
 *    to the renderer. This says only which columns survive a squeeze.
 */
export type ColumnPriority = 'primary' | 'normal' | 'extra'

/**
 * ✅ Whether the store can order by this property.
 *
 * ⚠️ Meaning, not decoration — and the distinction is load-bearing here. A
 *    derived column computed at read time often CANNOT be sorted without pulling
 *    the whole set into memory. A renderer that shows a sort arrow on it offers
 *    something the system cannot do, and the user finds out by clicking.
 */
export type Sortable = boolean

/** 📋 A property on the way out should say so before it goes. */
export type PropertyStatus = 'active' | 'experimental' | 'deprecated'

/**
 * ✅ The open extension point: tags a renderer may read, everything else ignores.
 *
 * ⚠️ This is the pressure valve that keeps the rest of the vocabulary closed,
 *    and rule ② makes it matter more, not less. Every presentational need that
 *    just got cut has somewhere to go: a renderer that wants a three-row box
 *    tags the property and reads the tag. No keyword, no version bump, no
 *    argument.
 *
 *    When three apps use the same tag, THAT is the evidence for promoting it.
 *    Until then a tag costs nothing and a keyword costs forever.
 */
export type TypeClasses = Record<string, string | number | boolean>

// ── What the data IS ──────────────────────────────────────────────────────
//
// ⚠️ THE PART THAT WAS CUT ONCE AND MUST NOT BE CUT AGAIN.
//
//    An earlier pass read all three derivation kinds off the reference, kept
//    `linked`, kept half of `aggregate` (`count` only), and dropped `math` as
//    "not needed yet". A warehouse entity then needed `sum` and a budget entity
//    needed arithmetic — both already on the list that had been trimmed.
//
//    This is the opposite side of rule ②: derivations are not presentation.
//    Nothing in the browser can work out that stock on hand is the sum of
//    movement lines. That is what the data MEANS, and meaning is the one thing
//    only the ontology can say.

export type AggregateFn = 'count' | 'sum' | 'min' | 'max' | 'avg'

/** An operator over two or more operands, each a property name or another node. */
export interface MathNode {
  op: '+' | '-' | '*' | '/'
  of: (string | MathNode)[]
}

export type Derived =
  /** ✅ A property of the object at the other end of a to-one link. */
  | { name: string; kind: 'linked'; via: string; show: string; label?: string }
  /** ✅ `count` · 📋 `sum` `min` `max` `avg` over a to-many link. */
  | { name: string; kind: 'aggregate'; fn: AggregateFn; via: string; of?: string; label?: string }
  /**
   * 📋 Arithmetic between properties of the SAME object.
   *
   * ⚠️ N-ary, and an operand may be another node — an expression TREE. The
   *    first version was binary, "for restraint", and the corpus answered
   *    within the hour: two of its three arithmetic properties need three
   *    operands. Still no expression STRING: a string needs a parser, and a
   *    parser in a declaration is where it stops being data.
   */
  | ({ name: string; label?: string; kind: 'math' } & MathNode)

/** Kept: the old spelling for counting links, before `aggregate` existed. */
export type LegacyCountLinks = { name: string; kind: 'countLinks'; via: string; label?: string }

// ── The gap, kept as data ─────────────────────────────────────────────────

export const IMPLEMENTED = {
  meaning: ['currency', 'percent'] as const,
  derived: ['linked', 'countLinks', 'aggregate.count'] as const,
  frame: ['visibility', 'keys.title', 'typeClasses'] as const,
} as const

/**
 * In the vocabulary, not yet read by the resolver.
 *
 * ⭐ This list was 14 entries. Nine of them left — not by being implemented, but
 *    because they were never ours: number and date formatting went back to
 *    `Intl`, and the conditional-formatting rule engine went back to the
 *    renderer. What remains is five things about MEANING, which no browser API
 *    can supply.
 */
export const DECLARED_NOT_RESOLVED = [
  'status',
  'derived.aggregate.sum', 'derived.aggregate.min',
  'derived.aggregate.max', 'derived.aggregate.avg',
  'derived.math',
] as const

/**
 * Words this package deliberately does NOT have, and where they went.
 *
 * ⚠️ Kept in the code, not only in a document, because the next person to feel
 *    the gap will be reading the type definitions — and the useful answer is
 *    not "no", it is "yes, over there".
 */
export const NOT_OURS = {
  'number formatting (grouping, notation, digits, unit, affix)': 'Intl.NumberFormat',
  'date formatting (styles, timezone)': 'Intl.DateTimeFormat',
  'conditional colour/icon/alignment rules': 'the renderer, in code',
  'multiline, wrap, field width, layout': 'HTML and CSS',
  'required, min, max, step, pattern': 'HTML form validation',
  'button wording, hints, prefilled values': 'props on the component that opens the dialog',
} as const
