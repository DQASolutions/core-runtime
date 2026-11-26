// HOW A STEP IS DONE — the task model of a process, beside its business rules.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE KERNEL OWNS THIS — and why it sits in the shared core
//
// A process says WHAT happens: which step moves a record from where to where,
// who may do it, what it records. It does not say how a person does it — whether
// anyone touches a screen at all, whether it is done on one record or a pile of
// them, what they must look at first, which fields they type and which the
// software fills. Every screen answers those questions. When the declaration is
// silent, whoever builds the screen answers them by guessing, and most of the
// time spent reworking a UI is spent reworking those guesses.
//
// Standard: W3C MBUI Task Models (WG Note, 2014) — task category, iteration,
// domain objects read/written. Only the part a screen-pattern selector needs to
// be TOTAL is here; layout, prominence and taste are NOT, and never will be.
// Those belong to the kit and to evaluation with real users (ISO 9241-210,
// ISO/IEC 25066).
//
// ⚠️ ABSENT MEANS UNDECLARED, not "the default". An app that says nothing about
//    `task` behaves exactly as before; a selector asked about it answers
//    "undetermined", never a guess. `[]` / `{}` are answers ("none").
// ═══════════════════════════════════════════════════════════════════════════
//
// The vocabulary is shared: the process runner (server) checks it, the lens (screen) reads it to
// pick a pattern. The checks over a process (`checkTaskShape`, `askedFields`) stay with the runner.

/** Who does the step: a person on the software · the software alone · a person away from it. */
export const TASK_CATEGORIES = ['interaction', 'system', 'user'] as const
export type TaskCategory = (typeof TASK_CATEGORIES)[number]

/** How a field gets its value: typed by a person · filled by the software · proposed by it, confirmed by a person. */
export const ENTRY_MODES = ['interaction', 'system', 'suggested'] as const
export type EntryMode = (typeof ENTRY_MODES)[number]

/** What a step done away from the software leaves: a signed paper (number, date, scan) · only a result. */
export const OFF_SYSTEM_RECORDS = ['document', 'outcome'] as const
export type OffSystemRecord = (typeof OFF_SYSTEM_RECORDS)[number]

/** One record · many records at once · many lines of one field inside one record. */
export type TaskIteration = 'single' | 'records' | { rows: string }

export interface TaskDecl {
  category?: TaskCategory
  iteration?: TaskIteration
  /** Fields the person must see to do the step, beyond the record itself. */
  reads?: string[]
  /** Every field the step records → how it gets its value. */
  filledBy?: Record<string, EntryMode>
  /** Only for `category: user`. */
  leaves?: OffSystemRecord
}

/** Per state: roles that may see a record there without being able to act on it. */
export type ReadersDecl = Record<string, string[]>
